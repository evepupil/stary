use crate::model::{
    Body, CollisionLedger, CollisionModel, ConservationCheck, Dissipation, EventState, EventTotals,
    LedgerChecks, MODEL_VERSION, Material, MaterialChecks, MaterialMasses, MechanicalEnergy,
    PassiveAsset, ReferenceFrame, ReservoirMasses, Vector,
};
use crate::physics::{
    GRAVITATIONAL_CONSTANT, add, compute_contact, cross, magnitude, material_masses, scale, sub,
    sum, sum_vectors,
};

const MASS_LIMIT: f64 = 1e-12;
const LINEAR_MOMENTUM_LIMIT: f64 = 1e-10;
const ANGULAR_MOMENTUM_LIMIT: f64 = 1e-8;
const ENERGY_LIMIT: f64 = 1e-6;
const SELF_BINDING_FACTOR: f64 = 3.0 / 5.0;

#[derive(Clone, Copy)]
struct CommonAsset<'a> {
    id: &'a str,
    mass_kg: f64,
    position: Vector,
    velocity: Vector,
    material_layers: &'a [crate::model::MaterialLayer],
    subgrid_energy: f64,
}

fn sorted_majors(state: &EventState) -> Vec<&Body> {
    let mut values: Vec<_> = state.major_bodies.iter().collect();
    values.sort_by(|left, right| left.id.as_bytes().cmp(right.id.as_bytes()));
    values
}

fn sorted_passives(state: &EventState) -> Vec<&PassiveAsset> {
    let mut values: Vec<_> = state.tracers.iter().chain(&state.dust_cohorts).collect();
    values.sort_by(|left, right| left.id.as_bytes().cmp(right.id.as_bytes()));
    values
}

fn all_assets(state: &EventState) -> Vec<CommonAsset<'_>> {
    let mut assets: Vec<_> = state
        .major_bodies
        .iter()
        .map(|body| CommonAsset {
            id: &body.id,
            mass_kg: body.mass_kg,
            position: body.position_meters,
            velocity: body.velocity_meters_per_second,
            material_layers: &body.material_layers,
            subgrid_energy: 0.0,
        })
        .chain(
            state
                .tracers
                .iter()
                .chain(&state.dust_cohorts)
                .map(|asset| CommonAsset {
                    id: &asset.id,
                    mass_kg: asset.mass_kg,
                    position: asset.position_meters,
                    velocity: asset.velocity_meters_per_second,
                    material_layers: &asset.material_layers,
                    subgrid_energy: asset.subgrid_mechanical_energy_joules,
                }),
        )
        .collect();
    assets.sort_by(|left, right| left.id.as_bytes().cmp(right.id.as_bytes()));
    assets
}

fn reference_frame(state: &EventState) -> Result<ReferenceFrame, String> {
    let assets = all_assets(state);
    if assets.is_empty() {
        return Err("碰撞守恒账本至少需要一个物理资产".into());
    }
    let total_mass = sum(assets.iter().map(|asset| asset.mass_kg))?;
    Ok(ReferenceFrame {
        origin_meters: scale(
            sum_vectors(
                assets
                    .iter()
                    .map(|asset| scale(asset.position, asset.mass_kg)),
            )?,
            1.0 / total_mass,
        )?,
        velocity_meters_per_second: scale(
            sum_vectors(
                assets
                    .iter()
                    .map(|asset| scale(asset.velocity, asset.mass_kg)),
            )?,
            1.0 / total_mass,
        )?,
    })
}

fn pair_potential(first: CommonAsset<'_>, second: CommonAsset<'_>) -> Result<f64, String> {
    let distance = magnitude(sub(first.position, second.position)?)?;
    if distance <= 0.0 {
        return Err(format!(
            "资产 {} 与 {} 的中心距离必须大于 0",
            first.id, second.id
        ));
    }
    Ok(-GRAVITATIONAL_CONSTANT * first.mass_kg * second.mass_kg / distance)
}

fn event_totals(state: &EventState, frame: &ReferenceFrame) -> Result<EventTotals, String> {
    let majors = sorted_majors(state);
    let passives = sorted_passives(state);
    let assets = all_assets(state);
    let mut material_terms: [Vec<f64>; 4] = std::array::from_fn(|_| Vec::new());
    for asset in &assets {
        let masses = material_masses(asset.mass_kg, asset.material_layers)?;
        material_terms[Material::Gas.index()].push(masses.gas);
        material_terms[Material::Ice.index()].push(masses.ice);
        material_terms[Material::Silicate.index()].push(masses.silicate);
        material_terms[Material::Iron.index()].push(masses.iron);
    }
    let materials = MaterialMasses {
        gas: sum(material_terms[Material::Gas.index()].iter().copied())?,
        ice: sum(material_terms[Material::Ice.index()].iter().copied())?,
        silicate: sum(material_terms[Material::Silicate.index()].iter().copied())?,
        iron: sum(material_terms[Material::Iron.index()].iter().copied())?,
    };

    let mut linear = Vec::with_capacity(assets.len());
    let mut orbital = Vec::with_capacity(assets.len());
    let mut translational = Vec::with_capacity(assets.len());
    for asset in &assets {
        let relative_velocity = sub(asset.velocity, frame.velocity_meters_per_second)?;
        let momentum = scale(relative_velocity, asset.mass_kg)?;
        linear.push(momentum);
        orbital.push(cross(sub(asset.position, frame.origin_meters)?, momentum)?);
        translational.push(0.5 * asset.mass_kg * magnitude(relative_velocity)?.powi(2));
    }

    let mut spins = Vec::with_capacity(majors.len());
    let mut spin_energy = Vec::with_capacity(majors.len());
    let mut self_binding = Vec::with_capacity(majors.len());
    for body in &majors {
        spins.push(body.spin_angular_momentum_kg_meters_squared_per_second);
        if body.collision_model == CollisionModel::BlackHole {
            continue;
        }
        let inertia_factor = body
            .moment_of_inertia_factor
            .ok_or_else(|| format!("天体 {} 缺少经典转动惯量因子", body.id))?;
        let spin_magnitude = magnitude(body.spin_angular_momentum_kg_meters_squared_per_second)?;
        let inertia = inertia_factor * body.mass_kg * body.radius_meters.powi(2);
        spin_energy.push(spin_magnitude.powi(2) / (2.0 * inertia));
        self_binding.push(
            -SELF_BINDING_FACTOR * GRAVITATIONAL_CONSTANT * body.mass_kg.powi(2)
                / body.radius_meters,
        );
    }

    let major_common: Vec<_> = majors
        .iter()
        .map(|body| CommonAsset {
            id: &body.id,
            mass_kg: body.mass_kg,
            position: body.position_meters,
            velocity: body.velocity_meters_per_second,
            material_layers: &body.material_layers,
            subgrid_energy: 0.0,
        })
        .collect();
    let passive_common: Vec<_> = passives
        .iter()
        .map(|asset| CommonAsset {
            id: &asset.id,
            mass_kg: asset.mass_kg,
            position: asset.position_meters,
            velocity: asset.velocity_meters_per_second,
            material_layers: &asset.material_layers,
            subgrid_energy: asset.subgrid_mechanical_energy_joules,
        })
        .collect();
    let mut active_active = Vec::new();
    for first in 0..major_common.len() {
        for second in first + 1..major_common.len() {
            active_active.push(pair_potential(major_common[first], major_common[second])?);
        }
    }
    let mut active_passive = Vec::new();
    for major in &major_common {
        for passive in &passive_common {
            active_passive.push(pair_potential(*major, *passive)?);
        }
    }

    let translational_joules = sum(translational)?;
    let spin_joules = sum(spin_energy)?;
    let active_active_potential_joules = sum(active_active)?;
    let active_passive_potential_joules = sum(active_passive)?;
    let self_binding_joules = sum(self_binding)?;
    let subgrid_joules = sum(passive_common.iter().map(|asset| asset.subgrid_energy))?;
    let total_joules = sum([
        translational_joules,
        spin_joules,
        active_active_potential_joules,
        active_passive_potential_joules,
        self_binding_joules,
        subgrid_joules,
    ])?;
    let major_kg = sum(majors.iter().map(|body| body.mass_kg))?;
    let tracer_kg = sum(state.tracers.iter().map(|asset| asset.mass_kg))?;
    let dust_kg = sum(state.dust_cohorts.iter().map(|asset| asset.mass_kg))?;

    Ok(EventTotals {
        reservoir_masses: ReservoirMasses {
            major_kg,
            tracer_kg,
            dust_kg,
            total_kg: sum([major_kg, tracer_kg, dust_kg])?,
        },
        material_masses_kg: materials,
        linear_momentum_kg_meters_per_second: sum_vectors(linear.into_iter().map(Ok))?,
        angular_momentum_kg_meters_squared_per_second: add(
            sum_vectors(orbital.into_iter().map(Ok))?,
            sum_vectors(spins.into_iter().map(Ok))?,
        )?,
        energy: MechanicalEnergy {
            translational_joules,
            spin_joules,
            active_active_potential_joules,
            active_passive_potential_joules,
            self_binding_joules,
            subgrid_joules,
            total_joules,
        },
    })
}

pub(crate) fn check(
    absolute_error: f64,
    scale_value: f64,
    threshold: f64,
    minimum_scale: f64,
) -> ConservationCheck {
    let scale = scale_value.max(minimum_scale);
    let normalized_error = absolute_error / scale;
    ConservationCheck {
        absolute_error,
        scale,
        normalized_error,
        threshold,
        passed: normalized_error <= threshold,
    }
}

pub(crate) fn compute_ledger(
    event_id: &str,
    simulation_time_seconds: f64,
    before_state: &EventState,
    after_state: &EventState,
    dissipation: Dissipation,
    participant_ids: [&str; 2],
) -> Result<CollisionLedger, String> {
    let first = before_state
        .major_bodies
        .iter()
        .find(|body| body.id == participant_ids[0])
        .ok_or("碰撞参与体必须存在于碰前主要天体快照")?;
    let second = before_state
        .major_bodies
        .iter()
        .find(|body| body.id == participant_ids[1])
        .ok_or("碰撞参与体必须存在于碰前主要天体快照")?;
    let contact = compute_contact(first, second)?;
    let frame = reference_frame(before_state)?;
    let before = event_totals(before_state, &frame)?;
    let after = event_totals(after_state, &frame)?;
    let before_assets = all_assets(before_state);
    let mut momentum_scale_terms = Vec::with_capacity(before_assets.len());
    let mut angular_scale_terms = Vec::with_capacity(before_assets.len());
    for asset in &before_assets {
        let relative_velocity = sub(asset.velocity, frame.velocity_meters_per_second)?;
        momentum_scale_terms.push(asset.mass_kg * magnitude(relative_velocity)?);
        let momentum = scale(relative_velocity, asset.mass_kg)?;
        angular_scale_terms.push(magnitude(cross(
            sub(asset.position, frame.origin_meters)?,
            momentum,
        )?)?);
    }
    let momentum_scale = sum(momentum_scale_terms)?
        .max(contact.total_mass_kg * contact.mutual_escape_speed_meters_per_second)
        .max(1.0);
    let angular_input_scale = sum(angular_scale_terms)?;
    let mut spin_scale_terms = Vec::with_capacity(before_state.major_bodies.len());
    for body in &before_state.major_bodies {
        spin_scale_terms.push(magnitude(
            body.spin_angular_momentum_kg_meters_squared_per_second,
        )?);
    }
    let spin_input_scale = sum(spin_scale_terms)?;
    let angular_scale = (angular_input_scale + spin_input_scale)
        .max(
            contact.total_mass_kg
                * contact.radius_sum_meters
                * contact.mutual_escape_speed_meters_per_second,
        )
        .max(1.0);
    let impact_energy_scale =
        0.5 * contact.reduced_mass_kg * contact.impact_speed_meters_per_second.powi(2)
            + GRAVITATIONAL_CONSTANT * contact.target_mass_kg * contact.projectile_mass_kg
                / contact.radius_sum_meters;
    let energy_scale = before
        .energy
        .total_joules
        .abs()
        .max(impact_energy_scale)
        .max(1.0);

    let material_check = |material: Material| {
        check(
            (after.material_masses_kg.get(material) - before.material_masses_kg.get(material))
                .abs(),
            before.reservoir_masses.total_kg,
            MASS_LIMIT,
            0.0,
        )
    };
    let mass = check(
        (after.reservoir_masses.total_kg - before.reservoir_masses.total_kg).abs(),
        before.reservoir_masses.total_kg,
        MASS_LIMIT,
        0.0,
    );
    let materials = MaterialChecks {
        gas: material_check(Material::Gas),
        ice: material_check(Material::Ice),
        silicate: material_check(Material::Silicate),
        iron: material_check(Material::Iron),
    };
    let linear = check(
        magnitude(sub(
            after.linear_momentum_kg_meters_per_second,
            before.linear_momentum_kg_meters_per_second,
        )?)?,
        momentum_scale,
        LINEAR_MOMENTUM_LIMIT,
        1.0,
    );
    let angular = check(
        magnitude(sub(
            after.angular_momentum_kg_meters_squared_per_second,
            before.angular_momentum_kg_meters_squared_per_second,
        )?)?,
        angular_scale,
        ANGULAR_MOMENTUM_LIMIT,
        1.0,
    );
    let total_dissipation = sum([
        dissipation.heat_joules,
        dissipation.deformation_joules,
        dissipation.fracture_joules,
        dissipation.radiation_joules,
    ])?;
    let energy = check(
        (before.energy.total_joules - after.energy.total_joules - total_dissipation).abs(),
        energy_scale,
        ENERGY_LIMIT,
        1.0,
    );
    let passed = mass.passed
        && materials.gas.passed
        && materials.ice.passed
        && materials.silicate.passed
        && materials.iron.passed
        && linear.passed
        && angular.passed
        && energy.passed;

    Ok(CollisionLedger {
        ledger_version: 1,
        model_version: MODEL_VERSION,
        event_id: event_id.to_owned(),
        simulation_time_seconds,
        reference_frame: frame,
        before,
        after,
        dissipation,
        checks: LedgerChecks {
            mass,
            material_masses: materials,
            linear_momentum: linear,
            angular_momentum: angular,
            energy,
        },
        omitted_interaction_classes: [
            "tracerTracerGravity",
            "tracerDustGravity",
            "dustDustGravity",
            "passiveBackreaction",
        ],
        passed,
    })
}
