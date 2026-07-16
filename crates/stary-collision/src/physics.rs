use std::collections::{BTreeMap, BTreeSet};

use crate::ledger::{check, compute_ledger};
use crate::model::{
    AngularLedgerEntry, BatchRequest, BlackHoleLedger, Body, Candidate, Classification,
    CollisionInput, CollisionModel, ConservationLimits, DisruptionScaling, Dissipation,
    EnergyLedgerEntry, ErrorCode, EventRequest, EventResolution, EventState, KernelError,
    MODEL_VERSION, Material, MaterialLayer, MaterialMasses, MaterialProfile, PassiveAsset,
    RECONSTRUCTION_VERSION, ReferenceFrame, ResolutionKind, ScalarLedgerEntry, Vector,
    VectorLedgerEntry,
};

pub(crate) const GRAVITATIONAL_CONSTANT: f64 = 6.6743e-11;
const SPEED_OF_LIGHT: f64 = 299_792_458.0;
const MINIMUM_CLASSIC_RADIUS: f64 = 1_000.0;
const REFERENCE_DENSITY: f64 = 1_000.0;
const FRAGMENT_RADIAL_ENERGY_FRACTION: f64 = 0.25;
const MATERIAL_FRACTION_TOLERANCE: f64 = 1e-12;
const MAX_MAJOR_BODIES: u32 = 512;
const MAX_PASSIVE_ASSETS: u32 = 10_000;
const MAX_EVENTS: usize = MAX_MAJOR_BODIES as usize / 2;

#[derive(Clone, Copy)]
struct CenterOfMass {
    mass_kg: f64,
    position: Vector,
    velocity: Vector,
}

pub(crate) fn finite(value: f64) -> Result<f64, String> {
    value
        .is_finite()
        .then_some(value)
        .ok_or_else(|| "物理计算结果超出有限数范围".into())
}

pub(crate) fn add(left: Vector, right: Vector) -> Result<Vector, String> {
    Ok(Vector {
        x: finite(left.x + right.x)?,
        y: finite(left.y + right.y)?,
        z: finite(left.z + right.z)?,
    })
}

pub(crate) fn sub(left: Vector, right: Vector) -> Result<Vector, String> {
    Ok(Vector {
        x: finite(left.x - right.x)?,
        y: finite(left.y - right.y)?,
        z: finite(left.z - right.z)?,
    })
}

pub(crate) fn scale(vector: Vector, factor: f64) -> Result<Vector, String> {
    finite(factor)?;
    Ok(Vector {
        x: finite(vector.x * factor)?,
        y: finite(vector.y * factor)?,
        z: finite(vector.z * factor)?,
    })
}

pub(crate) fn dot(left: Vector, right: Vector) -> Result<f64, String> {
    finite(left.x * right.x + left.y * right.y + left.z * right.z)
}

pub(crate) fn cross(left: Vector, right: Vector) -> Result<Vector, String> {
    Ok(Vector {
        x: finite(left.y * right.z - left.z * right.y)?,
        y: finite(left.z * right.x - left.x * right.z)?,
        z: finite(left.x * right.y - left.y * right.x)?,
    })
}

pub(crate) fn magnitude(vector: Vector) -> Result<f64, String> {
    finite(vector.x.hypot(vector.y).hypot(vector.z))
}

pub(crate) fn sum(values: impl IntoIterator<Item = f64>) -> Result<f64, String> {
    let mut compensation = 0.0;
    let mut total = 0.0;
    for value in values {
        finite(value)?;
        let corrected = value - compensation;
        let next = total + corrected;
        compensation = next - total - corrected;
        total = next;
    }
    finite(total)
}

pub(crate) fn sum_vectors(
    vectors: impl IntoIterator<Item = Result<Vector, String>>,
) -> Result<Vector, String> {
    let mut x = Vec::new();
    let mut y = Vec::new();
    let mut z = Vec::new();
    for vector in vectors {
        let vector = vector?;
        x.push(vector.x);
        y.push(vector.y);
        z.push(vector.z);
    }
    Ok(Vector {
        x: sum(x)?,
        y: sum(y)?,
        z: sum(z)?,
    })
}

fn valid_identifier(value: &str) -> bool {
    let utf16_length = value.encode_utf16().count();
    (1..=128).contains(&utf16_length) && !value.trim().is_empty()
}

fn validate_vector(vector: Vector) -> bool {
    vector.x.is_finite() && vector.y.is_finite() && vector.z.is_finite()
}

fn validate_layers(layers: &[MaterialLayer], required: bool) -> bool {
    if layers.len() > 4 || (required && layers.is_empty()) {
        return false;
    }
    let mut previous = None;
    let mut prefix = 0.0;
    let mut total = 0.0;
    for (index, layer) in layers.iter().enumerate() {
        if !layer.mass_fraction.is_finite()
            || layer.mass_fraction <= 0.0
            || layer.mass_fraction > 1.0
            || previous.is_some_and(|value| layer.material.index() <= value)
        {
            return false;
        }
        previous = Some(layer.material.index());
        if index + 1 < layers.len() {
            prefix += layer.mass_fraction;
            if prefix >= 1.0 {
                return false;
            }
        }
        total += layer.mass_fraction;
    }
    layers.is_empty() || (total - 1.0).abs() <= MATERIAL_FRACTION_TOLERANCE
}

fn validate_body(body: &Body) -> bool {
    if !valid_identifier(&body.id)
        || !body.mass_kg.is_finite()
        || body.mass_kg <= 0.0
        || !body.radius_meters.is_finite()
        || body.radius_meters <= 0.0
        || !validate_vector(body.position_meters)
        || !validate_vector(body.velocity_meters_per_second)
        || !validate_vector(body.spin_angular_momentum_kg_meters_squared_per_second)
    {
        return false;
    }
    match body.collision_model {
        CollisionModel::BlackHole => {
            body.moment_of_inertia_factor.is_none() && body.material_layers.is_empty()
        }
        _ => {
            body.moment_of_inertia_factor
                .is_some_and(|value| value.is_finite() && value > 0.0 && value <= 0.4)
                && validate_layers(&body.material_layers, true)
        }
    }
}

pub(crate) fn validate_request(request: &BatchRequest) -> Result<(), KernelError> {
    if request.abi_version != 1
        || request.model_version != MODEL_VERSION
        || request.reconstruction_version != RECONSTRUCTION_VERSION
        || request.events.is_empty()
        || request.events.len() > MAX_EVENTS
        || request.capacity.major_remnant_slots > MAX_MAJOR_BODIES
        || request.capacity.passive_asset_slots > MAX_PASSIVE_ASSETS
    {
        return Err(KernelError::new(
            ErrorCode::MalformedInput,
            None,
            "碰撞内核请求格式错误",
        ));
    }
    let mut event_ids = BTreeSet::new();
    let mut participants = BTreeMap::new();
    for event in &request.events {
        if let EventRequest::BlackHoleAccretion {
            expected_material_profile,
            ..
        } = event
            && !expected_material_profile.is_null()
        {
            return Err(KernelError::new(
                ErrorCode::MalformedInput,
                None,
                "blackHoleAccretion expectedMaterialProfile 必须是 null",
            ));
        }
        let input = event.input();
        if !valid_identifier(&input.event_id)
            || !input.simulation_time_seconds.is_finite()
            || input.simulation_time_seconds < 0.0
            || !validate_body(&input.first_body)
            || !validate_body(&input.second_body)
            || !event_ids.insert(input.event_id.clone())
        {
            return Err(KernelError::new(
                ErrorCode::MalformedInput,
                None,
                "碰撞内核请求格式错误",
            ));
        }
        for body in [&input.first_body, &input.second_body] {
            if participants
                .insert(body.id.clone(), input.event_id.clone())
                .is_some()
            {
                return Err(KernelError::new(
                    ErrorCode::MalformedInput,
                    None,
                    format!("碰撞内核批次包含共享参与体：{}", body.id),
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn material_masses(
    body_mass_kg: f64,
    layers: &[MaterialLayer],
) -> Result<MaterialMasses, String> {
    if layers.is_empty() {
        return Ok(MaterialMasses::default());
    }
    let mut assigned = 0.0;
    let mut masses = MaterialMasses::default();
    for (index, layer) in layers.iter().enumerate() {
        let mass = if index + 1 == layers.len() {
            finite(body_mass_kg - assigned)?
        } else {
            finite(body_mass_kg * layer.mass_fraction)?
        };
        if mass <= 0.0 {
            return Err("材料层换算后必须保留正质量".into());
        }
        assigned = finite(assigned + mass)?;
        masses.add(layer.material, mass);
    }
    Ok(masses)
}

fn layers_from_masses(
    masses: MaterialMasses,
    total_mass: f64,
) -> Result<Vec<MaterialLayer>, String> {
    let present: Vec<_> = Material::ALL
        .into_iter()
        .filter(|material| masses.get(*material) > 0.0)
        .collect();
    if present.is_empty() || !total_mass.is_finite() || total_mass <= 0.0 {
        return Err("经典残体必须保留正的材料质量".into());
    }
    let mut assigned = 0.0;
    let last = present.len() - 1;
    present
        .into_iter()
        .enumerate()
        .map(|(index, material)| {
            let mass_fraction = if index == last {
                1.0 - assigned
            } else {
                masses.get(material) / total_mass
            };
            if !mass_fraction.is_finite() || mass_fraction <= 0.0 {
                return Err("材料质量分数无法表示为正有限数".into());
            }
            assigned += mass_fraction;
            Ok(MaterialLayer {
                material,
                mass_fraction,
            })
        })
        .collect()
}

fn combined_layers(
    first: &Body,
    second: &Body,
    total_mass: f64,
) -> Result<Vec<MaterialLayer>, String> {
    let first_masses = material_masses(first.mass_kg, &first.material_layers)?;
    let second_masses = material_masses(second.mass_kg, &second.material_layers)?;
    layers_from_masses(
        MaterialMasses {
            gas: first_masses.gas + second_masses.gas,
            ice: first_masses.ice + second_masses.ice,
            silicate: first_masses.silicate + second_masses.silicate,
            iron: first_masses.iron + second_masses.iron,
        },
        total_mass,
    )
}

fn strip_outer_material(
    body_mass: f64,
    layers: &[MaterialLayer],
    removed_mass: f64,
) -> Result<(Vec<MaterialLayer>, Vec<MaterialLayer>), String> {
    let mut remaining = removed_mass;
    let mut retained = MaterialMasses::default();
    let mut ejected = MaterialMasses::default();
    let absolute = material_masses(body_mass, layers)?;
    for material in Material::ALL {
        let layer_mass = absolute.get(material);
        let ejected_mass = layer_mass.min(remaining);
        let retained_mass = finite(layer_mass - ejected_mass)?;
        remaining = finite(remaining - ejected_mass)?;
        if ejected_mass > 0.0 {
            ejected.add(material, ejected_mass);
        }
        if retained_mass > 0.0 {
            retained.add(material, retained_mass);
        }
    }
    Ok((
        layers_from_masses(retained, body_mass - removed_mass)?,
        layers_from_masses(ejected, removed_mass)?,
    ))
}

pub(crate) fn compute_contact(
    first: &Body,
    second: &Body,
) -> Result<crate::model::ContactQuantities, String> {
    if first.id == second.id {
        return Err("碰撞天体 id 不能相同".into());
    }
    let first_is_target = first.mass_kg > second.mass_kg
        || (first.mass_kg == second.mass_kg && first.radius_meters > second.radius_meters)
        || (first.mass_kg == second.mass_kg
            && first.radius_meters == second.radius_meters
            && first.id.as_bytes() < second.id.as_bytes());
    let (target, projectile) = if first_is_target {
        (first, second)
    } else {
        (second, first)
    };
    let relative_position = sub(projectile.position_meters, target.position_meters)?;
    let relative_velocity = sub(
        projectile.velocity_meters_per_second,
        target.velocity_meters_per_second,
    )?;
    let center_distance = magnitude(relative_position)?;
    let impact_speed = magnitude(relative_velocity)?;
    if center_distance <= 0.0 || impact_speed <= 0.0 {
        return Err("碰撞天体中心距离和相对速度必须大于 0".into());
    }
    let radius_sum = finite(target.radius_meters + projectile.radius_meters)?;
    let coordinate_scale = [
        radius_sum,
        target.position_meters.x.abs(),
        target.position_meters.y.abs(),
        target.position_meters.z.abs(),
        projectile.position_meters.x.abs(),
        projectile.position_meters.y.abs(),
        projectile.position_meters.z.abs(),
    ]
    .into_iter()
    .fold(0.0, f64::max);
    let tolerance = (1e-10 * radius_sum).max(64.0 * f64::EPSILON * coordinate_scale);
    if center_distance > radius_sum + tolerance {
        return Err("碰撞快照中的天体尚未接触".into());
    }
    let position_direction = scale(relative_position, 1.0 / center_distance)?;
    let velocity_direction = scale(relative_velocity, 1.0 / impact_speed)?;
    if dot(position_direction, velocity_direction)? > 0.0 {
        return Err("碰撞快照中的天体已经开始分离".into());
    }
    let total_mass = finite(target.mass_kg + projectile.mass_kg)?;
    let reduced_mass = finite(projectile.mass_kg / (1.0 + projectile.mass_kg / target.mass_kg))?;
    let mass_ratio = projectile.mass_kg / target.mass_kg;
    let impact_parameter =
        magnitude(cross(position_direction, velocity_direction)?)?.clamp(0.0, 1.0);
    let impact_angle = impact_parameter.asin();
    let critical_impact_parameter = target.radius_meters / radius_sum;
    let interacting_length =
        (radius_sum * (1.0 - impact_parameter)).clamp(0.0, 2.0 * projectile.radius_meters);
    let length_ratio = interacting_length / projectile.radius_meters;
    let interacting_fraction = if interacting_length >= 2.0 * projectile.radius_meters {
        1.0
    } else {
        (3.0 * length_ratio.powi(2) - length_ratio.powi(3)) / 4.0
    }
    .clamp(0.0, 1.0);
    let interacting_mass = interacting_fraction * projectile.mass_kg;
    let interacting_reduced_mass = if interacting_mass > 0.0 {
        finite(interacting_mass / (1.0 + interacting_mass / target.mass_kg))?
    } else {
        0.0
    };
    let escape_speed = ((2.0 * GRAVITATIONAL_CONSTANT * total_mass) / radius_sum).sqrt();
    let specific_energy = finite(0.5 * (reduced_mass / total_mass) * impact_speed.powi(2))?;
    Ok(crate::model::ContactQuantities {
        target_body_id: target.id.clone(),
        projectile_body_id: projectile.id.clone(),
        target_mass_kg: target.mass_kg,
        projectile_mass_kg: projectile.mass_kg,
        target_radius_meters: target.radius_meters,
        projectile_radius_meters: projectile.radius_meters,
        total_mass_kg: total_mass,
        reduced_mass_kg: reduced_mass,
        interacting_reduced_mass_kg: interacting_reduced_mass,
        mass_ratio,
        center_distance_meters: center_distance,
        radius_sum_meters: radius_sum,
        impact_speed_meters_per_second: impact_speed,
        mutual_escape_speed_meters_per_second: escape_speed,
        specific_impact_energy_joules_per_kg: specific_energy,
        impact_angle_radians: impact_angle,
        impact_parameter,
        critical_impact_parameter,
        interacting_length_meters: interacting_length,
        interacting_projectile_fraction: interacting_fraction,
        grazing: impact_parameter > critical_impact_parameter,
    })
}

fn disruption(
    contact: &crate::model::ContactQuantities,
    profile: MaterialProfile,
) -> Result<DisruptionScaling, String> {
    let (c_star, mu_bar) = match profile {
        MaterialProfile::GravitySolid => (5.0, 0.37),
        MaterialProfile::GravityFluid => (1.9, 0.36),
    };
    let equivalent_radius =
        ((contact.total_mass_kg / REFERENCE_DENSITY) * (3.0 / (4.0 * std::f64::consts::PI))).cbrt();
    let principal = c_star
        * (4.0 / 5.0)
        * std::f64::consts::PI
        * REFERENCE_DENSITY
        * GRAVITATIONAL_CONSTANT
        * equivalent_radius.powi(2);
    let symmetric = (1.0 / 4.0) * ((contact.mass_ratio + 1.0).powi(2) / contact.mass_ratio);
    let mass_ratio_scale = symmetric.powf(2.0 / (3.0 * mu_bar) - 1.0);
    let head_on = principal * mass_ratio_scale;
    let obliquity_scale = (contact.reduced_mass_kg / contact.interacting_reduced_mass_kg)
        .powf(2.0 - (3.0 * mu_bar) / 2.0);
    let threshold = head_on * obliquity_scale;
    let critical_speed =
        (2.0 * threshold * (contact.total_mass_kg / contact.reduced_mass_kg)).sqrt();
    let normalized = contact.specific_impact_energy_joules_per_kg / threshold;
    for value in [
        equivalent_radius,
        principal,
        mass_ratio_scale,
        head_on,
        obliquity_scale,
        threshold,
        critical_speed,
        normalized,
    ] {
        finite(value)?;
    }
    Ok(DisruptionScaling {
        material_profile: profile,
        equivalent_combined_radius_meters: equivalent_radius,
        principal_disruption_threshold_joules_per_kg: principal,
        mass_ratio_scale,
        head_on_disruption_threshold_joules_per_kg: head_on,
        obliquity_scale,
        obliquity_model_extrapolated: contact.interacting_projectile_fraction <= 0.5,
        disruption_threshold_joules_per_kg: threshold,
        critical_impact_speed_meters_per_second: critical_speed,
        normalized_impact_energy: normalized,
    })
}

fn largest_remnant_fraction(normalized: f64) -> f64 {
    let value = if normalized <= 1.8 {
        1.0 - 0.5 * normalized
    } else {
        (0.1 / 1.8_f64.powf(-1.5)) * normalized.powf(-1.5)
    };
    value.clamp(0.0, 1.0)
}

fn genda_ratio(mass_ratio: f64, impact_parameter: f64) -> f64 {
    let gamma = (1.0 - mass_ratio) / (1.0 + mass_ratio);
    let angle = (1.0 - impact_parameter).powf(2.5);
    2.43 * gamma * angle + -0.0408 * gamma + 1.86 * angle + 1.08
}

fn genda_extrapolated(contact: &crate::model::ContactQuantities) -> bool {
    let speed_ratio =
        contact.impact_speed_meters_per_second / contact.mutual_escape_speed_meters_per_second;
    let earth_masses = contact.total_mass_kg / 5.9722e24;
    contact.mass_ratio < 1.0 / 9.0
        || contact.impact_parameter > (75.0_f64.to_radians()).sin()
        || !(1.0..=3.0).contains(&speed_ratio)
        || !(0.2..=2.0).contains(&earth_masses)
}

fn classify(
    contact: &crate::model::ContactQuantities,
    normalized: f64,
    genda: Option<f64>,
) -> Option<Classification> {
    if contact.impact_speed_meters_per_second <= contact.mutual_escape_speed_meters_per_second {
        Some(Classification::Merge)
    } else if normalized > 1.8 {
        Some(Classification::SuperCatastrophicDisruption)
    } else if normalized >= 1.0 {
        Some(Classification::CatastrophicDisruption)
    } else if largest_remnant_fraction(normalized) <= contact.target_mass_kg / contact.total_mass_kg
    {
        Some(Classification::Erosion)
    } else if !contact.grazing {
        Some(Classification::PartialAccretion)
    } else {
        genda.map(|ratio| {
            if contact.impact_speed_meters_per_second
                <= ratio * contact.mutual_escape_speed_meters_per_second
            {
                Classification::GrazeAndMerge
            } else {
                Classification::HitAndRun
            }
        })
    }
}

fn candidate(first: &Body, second: &Body, profile: MaterialProfile) -> Result<Candidate, String> {
    let contact = compute_contact(first, second)?;
    if contact.interacting_projectile_fraction == 0.0 {
        let target_fraction = contact.target_mass_kg / contact.total_mass_kg;
        let target_mass = contact.target_mass_kg;
        return Ok(Candidate {
            model_version: MODEL_VERSION,
            resolution_kind: ResolutionKind::NonInteractingTangent,
            classification: Classification::HitAndRun,
            contact,
            disruption: None,
            largest_remnant_mass_fraction: Some(target_fraction),
            largest_remnant_mass_kg: Some(target_mass),
            genda_critical_velocity_ratio: None,
            genda_model_extrapolated: None,
        });
    }
    let disruption = disruption(&contact, profile)?;
    let needs_genda = classify(&contact, disruption.normalized_impact_energy, None).is_none();
    let genda = needs_genda.then(|| genda_ratio(contact.mass_ratio, contact.impact_parameter));
    let classification = classify(&contact, disruption.normalized_impact_energy, genda)
        .ok_or("擦碰分类必须提供 Genda 临界速度")?;
    let universal_fraction = largest_remnant_fraction(disruption.normalized_impact_energy);
    let reported_fraction = match classification {
        Classification::Merge | Classification::GrazeAndMerge => Some(1.0),
        Classification::HitAndRun => None,
        _ => Some(universal_fraction),
    };
    let reported_mass = reported_fraction.map(|fraction| fraction * contact.total_mass_kg);
    let extrapolated = genda.map(|_| genda_extrapolated(&contact));
    Ok(Candidate {
        model_version: MODEL_VERSION,
        resolution_kind: ResolutionKind::ModeledCollision,
        classification,
        contact,
        disruption: Some(disruption),
        largest_remnant_mass_fraction: reported_fraction,
        largest_remnant_mass_kg: reported_mass,
        genda_critical_velocity_ratio: genda,
        genda_model_extrapolated: extrapolated,
    })
}

fn center_of_mass(first: &Body, second: &Body) -> Result<CenterOfMass, String> {
    let mass = finite(first.mass_kg + second.mass_kg)?;
    Ok(CenterOfMass {
        mass_kg: mass,
        position: scale(
            sum_vectors([
                scale(first.position_meters, first.mass_kg),
                scale(second.position_meters, second.mass_kg),
            ])?,
            1.0 / mass,
        )?,
        velocity: scale(
            sum_vectors([
                scale(first.velocity_meters_per_second, first.mass_kg),
                scale(second.velocity_meters_per_second, second.mass_kg),
            ])?,
            1.0 / mass,
        )?,
    })
}

fn orbital_angular_momentum(
    first: &Body,
    second: &Body,
    frame: CenterOfMass,
) -> Result<Vector, String> {
    sum_vectors([first, second].into_iter().map(|body| {
        cross(
            sub(body.position_meters, frame.position)?,
            scale(
                sub(body.velocity_meters_per_second, frame.velocity)?,
                body.mass_kg,
            )?,
        )
    }))
}

fn total_spin(first: &Body, second: &Body) -> Result<Vector, String> {
    add(
        first.spin_angular_momentum_kg_meters_squared_per_second,
        second.spin_angular_momentum_kg_meters_squared_per_second,
    )
}

fn total_angular_momentum(
    first: &Body,
    second: &Body,
    frame: CenterOfMass,
) -> Result<Vector, String> {
    add(
        orbital_angular_momentum(first, second, frame)?,
        total_spin(first, second)?,
    )
}

fn combined_radius(first: &Body, second: &Body) -> Result<f64, String> {
    let radius = (first.radius_meters.powi(3) + second.radius_meters.powi(3)).cbrt();
    if !radius.is_finite() || radius <= 0.0 {
        return Err("平均密度残体半径超出有限数范围".into());
    }
    Ok(radius)
}

fn inertia_factor(first: &Body, second: &Body, total_mass: f64) -> Result<f64, String> {
    let first_factor = first
        .moment_of_inertia_factor
        .ok_or("经典重建缺少转动惯量因子")?;
    let second_factor = second
        .moment_of_inertia_factor
        .ok_or("经典重建缺少转动惯量因子")?;
    Ok((first_factor * first.mass_kg + second_factor * second.mass_kg) / total_mass)
}

fn fragment_id(event_id: &str, first_id: &str, second_id: &str, kind: &str) -> String {
    let (first, second) = if first_id.as_bytes() < second_id.as_bytes() {
        (first_id, second_id)
    } else {
        (second_id, first_id)
    };
    let fields = [
        "collision-seed-v1",
        MODEL_VERSION,
        event_id,
        first,
        second,
        kind,
        "0",
    ];
    let mut hash = 0xcbf29ce484222325_u64;
    for field in fields {
        for byte in (field.len() as u32)
            .to_be_bytes()
            .into_iter()
            .chain(field.bytes())
        {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{kind}-{hash:016x}")
}

fn before_state(input: &CollisionInput) -> EventState {
    let mut bodies = vec![input.first_body.clone(), input.second_body.clone()];
    bodies.sort_by(|left, right| left.id.as_bytes().cmp(right.id.as_bytes()));
    EventState {
        major_bodies: bodies,
        ..EventState::default()
    }
}

struct FinalizeSpec {
    major_ids: Vec<String>,
    tracer_ids: Vec<String>,
    dust_ids: Vec<String>,
    channel: &'static str,
    approximations: Vec<&'static str>,
}

fn finalize_classic(
    input: &CollisionInput,
    profile: MaterialProfile,
    candidate: Candidate,
    after: EventState,
    spec: FinalizeSpec,
) -> Result<EventResolution, KernelError> {
    let before = before_state(input);
    let participant_ids = [input.first_body.id.as_str(), input.second_body.id.as_str()];
    let provisional = compute_ledger(
        &input.event_id,
        input.simulation_time_seconds,
        &before,
        &after,
        Dissipation::default(),
        participant_ids,
    )
    .map_err(|message| numerical_error(input, message))?;
    let mechanical_loss =
        provisional.before.energy.total_joules - provisional.after.energy.total_joules;
    if mechanical_loss < 0.0 && !provisional.checks.energy.passed {
        return Err(KernelError::new(
            ErrorCode::CollisionReconstructionFailed,
            Some(&input.event_id),
            "确定性重建需要负耗散才能闭合机械能",
        ));
    }
    let mut dissipation = Dissipation::default();
    match spec.channel {
        "heat" => dissipation.heat_joules = mechanical_loss.max(0.0),
        "deformation" => dissipation.deformation_joules = mechanical_loss.max(0.0),
        "fracture" => dissipation.fracture_joules = mechanical_loss.max(0.0),
        _ => {}
    }
    let ledger = compute_ledger(
        &input.event_id,
        input.simulation_time_seconds,
        &before,
        &after,
        dissipation,
        participant_ids,
    )
    .map_err(|message| numerical_error(input, message))?;
    if !ledger.passed {
        return Err(KernelError::new(
            ErrorCode::CollisionConservationFailed,
            Some(&input.event_id),
            "确定性重建未通过 event-total 守恒门禁",
        ));
    }
    Ok(EventResolution::Classic {
        event_id: input.event_id.clone(),
        participant_body_ids: [
            candidate.contact.target_body_id.clone(),
            candidate.contact.projectile_body_id.clone(),
        ],
        expected_material_profile: profile,
        ledger_scope: "participantLocalEventTotal",
        candidate,
        after,
        dissipation,
        ledger: Box::new(ledger),
        major_remnant_ids: spec.major_ids,
        tracer_ids: spec.tracer_ids,
        dust_cohort_ids: spec.dust_ids,
        approximations: spec.approximations,
    })
}

fn numerical_error(input: &CollisionInput, message: String) -> KernelError {
    KernelError::new(
        ErrorCode::CollisionNumericalFailure,
        Some(&input.event_id),
        message,
    )
}

fn reconstruct_merge(
    input: &CollisionInput,
    profile: MaterialProfile,
    candidate: Candidate,
) -> Result<EventResolution, KernelError> {
    let first = &input.first_body;
    let second = &input.second_body;
    let frame = center_of_mass(first, second).map_err(|message| numerical_error(input, message))?;
    let remnant_id = fragment_id(&input.event_id, &first.id, &second.id, "major");
    let remnant = Body {
        id: remnant_id.clone(),
        mass_kg: frame.mass_kg,
        radius_meters: combined_radius(first, second)
            .map_err(|message| numerical_error(input, message))?,
        position_meters: frame.position,
        velocity_meters_per_second: frame.velocity,
        spin_angular_momentum_kg_meters_squared_per_second: total_angular_momentum(
            first, second, frame,
        )
        .map_err(|message| numerical_error(input, message))?,
        moment_of_inertia_factor: Some(
            inertia_factor(first, second, frame.mass_kg)
                .map_err(|message| numerical_error(input, message))?,
        ),
        material_layers: combined_layers(first, second, frame.mass_kg)
            .map_err(|message| numerical_error(input, message))?,
        collision_model: profile.into(),
    };
    finalize_classic(
        input,
        profile,
        candidate,
        EventState {
            major_bodies: vec![remnant],
            ..EventState::default()
        },
        FinalizeSpec {
            major_ids: vec![remnant_id],
            tracer_ids: vec![],
            dust_ids: vec![],
            channel: "heat",
            approximations: vec![
                "combinedMaterialBuckets",
                "participantLocalLedger",
                "remnantDensity",
            ],
        },
    )
}

fn reconstruct_hit_and_run(
    input: &CollisionInput,
    profile: MaterialProfile,
    candidate: Candidate,
) -> Result<EventResolution, KernelError> {
    let first = &input.first_body;
    let second = &input.second_body;
    let frame = center_of_mass(first, second).map_err(|message| numerical_error(input, message))?;
    let relative_position = sub(second.position_meters, first.position_meters)
        .map_err(|message| numerical_error(input, message))?;
    let normal = scale(
        relative_position,
        1.0 / magnitude(relative_position).map_err(|message| numerical_error(input, message))?,
    )
    .map_err(|message| numerical_error(input, message))?;
    let incoming = sub(
        second.velocity_meters_per_second,
        first.velocity_meters_per_second,
    )
    .map_err(|message| numerical_error(input, message))?;
    let radial_speed = dot(incoming, normal).map_err(|message| numerical_error(input, message))?;
    if radial_speed == 0.0 && candidate.resolution_kind != ResolutionKind::NonInteractingTangent {
        return Err(KernelError::new(
            ErrorCode::CollisionReconstructionFailed,
            Some(&input.event_id),
            "有交互质量的切向 hit-and-run 无法通过径向镜像生成分离状态",
        ));
    }
    let outgoing = sub(
        incoming,
        scale(normal, 2.0 * radial_speed.min(0.0))
            .map_err(|message| numerical_error(input, message))?,
    )
    .map_err(|message| numerical_error(input, message))?;
    let mut first_after = first.clone();
    first_after.velocity_meters_per_second = sub(
        frame.velocity,
        scale(outgoing, second.mass_kg / frame.mass_kg)
            .map_err(|message| numerical_error(input, message))?,
    )
    .map_err(|message| numerical_error(input, message))?;
    let mut second_after = second.clone();
    second_after.velocity_meters_per_second = add(
        frame.velocity,
        scale(outgoing, first.mass_kg / frame.mass_kg)
            .map_err(|message| numerical_error(input, message))?,
    )
    .map_err(|message| numerical_error(input, message))?;
    let mut bodies = vec![first_after, second_after];
    bodies.sort_by(|left, right| left.id.as_bytes().cmp(right.id.as_bytes()));
    let ids = bodies.iter().map(|body| body.id.clone()).collect();
    finalize_classic(
        input,
        profile,
        candidate,
        EventState {
            major_bodies: bodies,
            ..EventState::default()
        },
        FinalizeSpec {
            major_ids: ids,
            tracer_ids: vec![],
            dust_ids: vec![],
            channel: "deformation",
            approximations: vec!["participantLocalLedger", "separationKinematics"],
        },
    )
}

fn reconstruct_disruption(
    input: &CollisionInput,
    profile: MaterialProfile,
    candidate: Candidate,
) -> Result<EventResolution, KernelError> {
    let first = &input.first_body;
    let second = &input.second_body;
    let frame = center_of_mass(first, second).map_err(|message| numerical_error(input, message))?;
    let major_mass = candidate.largest_remnant_mass_kg.ok_or_else(|| {
        KernelError::new(
            ErrorCode::CollisionReconstructionFailed,
            Some(&input.event_id),
            "破坏结果需要一个正质量最大残体和一个正质量被动资产",
        )
    })?;
    if major_mass <= 0.0 || major_mass >= frame.mass_kg {
        return Err(KernelError::new(
            ErrorCode::CollisionReconstructionFailed,
            Some(&input.event_id),
            "破坏结果需要一个正质量最大残体和一个正质量被动资产",
        ));
    }
    let passive_mass = frame.mass_kg - major_mass;
    let layers = combined_layers(first, second, frame.mass_kg)
        .map_err(|message| numerical_error(input, message))?;
    let (major_layers, passive_layers) = strip_outer_material(frame.mass_kg, &layers, passive_mass)
        .map_err(|message| numerical_error(input, message))?;
    let major_id = fragment_id(&input.event_id, &first.id, &second.id, "major");
    let passive_kind = if matches!(
        candidate.classification,
        Classification::CatastrophicDisruption | Classification::SuperCatastrophicDisruption
    ) {
        "dust"
    } else {
        "tracer"
    };
    let passive_id = fragment_id(&input.event_id, &first.id, &second.id, passive_kind);
    let relative_position = sub(second.position_meters, first.position_meters)
        .map_err(|message| numerical_error(input, message))?;
    let separation =
        magnitude(relative_position).map_err(|message| numerical_error(input, message))?;
    let normal = scale(relative_position, 1.0 / separation)
        .map_err(|message| numerical_error(input, message))?;
    let reduced_after = passive_mass / (1.0 + passive_mass / major_mass);
    let orbital = orbital_angular_momentum(first, second, frame)
        .map_err(|message| numerical_error(input, message))?;
    let tangential = scale(
        cross(orbital, normal).map_err(|message| numerical_error(input, message))?,
        1.0 / (reduced_after * separation),
    )
    .map_err(|message| numerical_error(input, message))?;
    let major_radius = combined_radius(first, second)
        .map_err(|message| numerical_error(input, message))?
        * (major_mass / frame.mass_kg).cbrt();
    let inertia = inertia_factor(first, second, frame.mass_kg)
        .map_err(|message| numerical_error(input, message))?;
    let major_position = sub(
        frame.position,
        scale(normal, (passive_mass / frame.mass_kg) * separation)
            .map_err(|message| numerical_error(input, message))?,
    )
    .map_err(|message| numerical_error(input, message))?;
    let passive_position = add(
        frame.position,
        scale(normal, (major_mass / frame.mass_kg) * separation)
            .map_err(|message| numerical_error(input, message))?,
    )
    .map_err(|message| numerical_error(input, message))?;
    let total_spin =
        total_spin(first, second).map_err(|message| numerical_error(input, message))?;

    let build_after = |radial_speed: f64| -> Result<EventState, KernelError> {
        let relative_velocity = add(
            tangential,
            scale(normal, radial_speed).map_err(|message| numerical_error(input, message))?,
        )
        .map_err(|message| numerical_error(input, message))?;
        let major_velocity = sub(
            frame.velocity,
            scale(relative_velocity, passive_mass / frame.mass_kg)
                .map_err(|message| numerical_error(input, message))?,
        )
        .map_err(|message| numerical_error(input, message))?;
        let passive_velocity = add(
            frame.velocity,
            scale(relative_velocity, major_mass / frame.mass_kg)
                .map_err(|message| numerical_error(input, message))?,
        )
        .map_err(|message| numerical_error(input, message))?;
        let major = Body {
            id: major_id.clone(),
            mass_kg: major_mass,
            radius_meters: major_radius,
            position_meters: major_position,
            velocity_meters_per_second: major_velocity,
            spin_angular_momentum_kg_meters_squared_per_second: total_spin,
            moment_of_inertia_factor: Some(inertia),
            material_layers: major_layers.clone(),
            collision_model: profile.into(),
        };
        let passive = PassiveAsset {
            id: passive_id.clone(),
            mass_kg: passive_mass,
            position_meters: passive_position,
            velocity_meters_per_second: passive_velocity,
            material_layers: passive_layers.clone(),
            subgrid_mechanical_energy_joules: 0.0,
        };
        Ok(if passive_kind == "tracer" {
            EventState {
                major_bodies: vec![major],
                tracers: vec![passive],
                dust_cohorts: vec![],
            }
        } else {
            EventState {
                major_bodies: vec![major],
                tracers: vec![],
                dust_cohorts: vec![passive],
            }
        })
    };
    let before = before_state(input);
    let base_after = build_after(0.0)?;
    let base_ledger = compute_ledger(
        &input.event_id,
        input.simulation_time_seconds,
        &before,
        &base_after,
        Dissipation::default(),
        [first.id.as_str(), second.id.as_str()],
    )
    .map_err(|message| numerical_error(input, message))?;
    let energy_available =
        base_ledger.before.energy.total_joules - base_ledger.after.energy.total_joules;
    if !energy_available.is_finite() || energy_available <= 0.0 {
        return Err(KernelError::new(
            ErrorCode::CollisionReconstructionFailed,
            Some(&input.event_id),
            "破坏结果没有足够机械能生成守恒的分离状态",
        ));
    }
    let maximum_radial_speed = (2.0 * energy_available / reduced_after).sqrt();
    let incoming_radial_speed = dot(
        sub(
            second.velocity_meters_per_second,
            first.velocity_meters_per_second,
        )
        .map_err(|message| numerical_error(input, message))?,
        normal,
    )
    .map_err(|message| numerical_error(input, message))?
    .abs();
    let radial_speed = incoming_radial_speed
        .max(candidate.contact.mutual_escape_speed_meters_per_second * 1e-12)
        .min(maximum_radial_speed * FRAGMENT_RADIAL_ENERGY_FRACTION.sqrt());
    if !radial_speed.is_finite() || radial_speed <= 0.0 {
        return Err(KernelError::new(
            ErrorCode::CollisionReconstructionFailed,
            Some(&input.event_id),
            "破坏结果无法生成正的径向分离速度",
        ));
    }
    let after = build_after(radial_speed)?;
    let catastrophic = matches!(
        candidate.classification,
        Classification::CatastrophicDisruption | Classification::SuperCatastrophicDisruption
    );
    finalize_classic(
        input,
        profile,
        candidate,
        after,
        FinalizeSpec {
            major_ids: vec![major_id],
            tracer_ids: if passive_kind == "tracer" {
                vec![passive_id.clone()]
            } else {
                vec![]
            },
            dust_ids: if passive_kind == "dust" {
                vec![passive_id]
            } else {
                vec![]
            },
            channel: if catastrophic {
                "fracture"
            } else {
                "deformation"
            },
            approximations: vec![
                "combinedMaterialBuckets",
                "participantLocalLedger",
                "passiveFragment",
                "remnantDensity",
                "separationKinematics",
            ],
        },
    )
}

fn resolve_classic(
    input: &CollisionInput,
    profile: MaterialProfile,
) -> Result<EventResolution, KernelError> {
    for body in [&input.first_body, &input.second_body] {
        match body.collision_model {
            CollisionModel::Stellar => {
                return Err(KernelError::new(
                    ErrorCode::UnsupportedStellarCollision,
                    Some(&input.event_id),
                    "恒星碰撞超出工程确定性 v1 范围",
                ));
            }
            CollisionModel::BlackHole => {
                return Err(KernelError::new(
                    ErrorCode::UnsupportedCollisionDomain,
                    Some(&input.event_id),
                    "黑洞参与体必须使用 blackHoleAccretion domain",
                ));
            }
            _ => {}
        }
        if body.radius_meters < MINIMUM_CLASSIC_RADIUS {
            return Err(KernelError::new(
                ErrorCode::UnsupportedStrengthRegime,
                Some(&input.event_id),
                "半径小于 1 km 的强度主导天体超出工程确定性 v1 范围",
            ));
        }
    }
    let candidate = candidate(&input.first_body, &input.second_body, profile)
        .map_err(|message| numerical_error(input, message))?;
    match candidate.classification {
        Classification::Merge | Classification::GrazeAndMerge => {
            reconstruct_merge(input, profile, candidate)
        }
        Classification::HitAndRun => reconstruct_hit_and_run(input, profile, candidate),
        _ => reconstruct_disruption(input, profile, candidate),
    }
}

fn compute_black_hole_ledger(
    input: &CollisionInput,
    remnant: &Body,
    frame: CenterOfMass,
) -> Result<BlackHoleLedger, KernelError> {
    let first = &input.first_body;
    let second = &input.second_body;
    let before_linear = sum_vectors([
        scale(first.velocity_meters_per_second, first.mass_kg),
        scale(second.velocity_meters_per_second, second.mass_kg),
    ])
    .map_err(|message| numerical_error(input, message))?;
    let after_linear = scale(remnant.velocity_meters_per_second, remnant.mass_kg)
        .map_err(|message| numerical_error(input, message))?;
    let before_angular = total_angular_momentum(first, second, frame)
        .map_err(|message| numerical_error(input, message))?;
    let after_angular = remnant.spin_angular_momentum_kg_meters_squared_per_second;
    let mut relative_kinetic_terms = Vec::with_capacity(2);
    for body in [first, second] {
        let relative = sub(body.velocity_meters_per_second, frame.velocity)
            .map_err(|message| numerical_error(input, message))?;
        relative_kinetic_terms.push(
            0.5 * body.mass_kg
                * magnitude(relative)
                    .map_err(|message| numerical_error(input, message))?
                    .powi(2),
        );
    }
    let relative_kinetic =
        sum(relative_kinetic_terms).map_err(|message| numerical_error(input, message))?;
    let mut materials = MaterialMasses::default();
    for body in [first, second] {
        if body.collision_model != CollisionModel::BlackHole {
            let masses = material_masses(body.mass_kg, &body.material_layers)
                .map_err(|message| numerical_error(input, message))?;
            materials.gas += masses.gas;
            materials.ice += masses.ice;
            materials.silicate += masses.silicate;
            materials.iron += masses.iron;
        }
    }
    let mass_check = check(
        (remnant.mass_kg - frame.mass_kg).abs(),
        frame.mass_kg,
        1e-12,
        1.0,
    );
    let linear_scale = (first.mass_kg
        * magnitude(first.velocity_meters_per_second)
            .map_err(|message| numerical_error(input, message))?
        + second.mass_kg
            * magnitude(second.velocity_meters_per_second)
                .map_err(|message| numerical_error(input, message))?)
    .max(1.0);
    let linear_check = check(
        magnitude(
            sub(after_linear, before_linear).map_err(|message| numerical_error(input, message))?,
        )
        .map_err(|message| numerical_error(input, message))?,
        linear_scale,
        1e-10,
        1.0,
    );
    let angular_check = check(
        magnitude(
            sub(after_angular, before_angular)
                .map_err(|message| numerical_error(input, message))?,
        )
        .map_err(|message| numerical_error(input, message))?,
        magnitude(before_angular)
            .map_err(|message| numerical_error(input, message))?
            .max(1.0),
        1e-8,
        1.0,
    );
    let energy_check = check(0.0, relative_kinetic.max(1.0), 1e-6, 1.0);
    let passed =
        mass_check.passed && linear_check.passed && angular_check.passed && energy_check.passed;
    Ok(BlackHoleLedger {
        ledger_version: 1,
        model_version: MODEL_VERSION,
        reconstruction_version: RECONSTRUCTION_VERSION,
        event_id: input.event_id.clone(),
        simulation_time_seconds: input.simulation_time_seconds,
        reference_frame: ReferenceFrame {
            origin_meters: frame.position,
            velocity_meters_per_second: frame.velocity,
        },
        energy_scope: "relativeKineticOnly",
        mass: ScalarLedgerEntry {
            before_kg: frame.mass_kg,
            after_kg: remnant.mass_kg,
            check: mass_check,
        },
        linear_momentum: VectorLedgerEntry {
            before_kg_meters_per_second: before_linear,
            after_kg_meters_per_second: after_linear,
            check: linear_check,
        },
        angular_momentum: AngularLedgerEntry {
            before_kg_meters_squared_per_second: before_angular,
            after_kg_meters_squared_per_second: after_angular,
            check: angular_check,
        },
        relative_kinetic_energy: EnergyLedgerEntry {
            before_joules: relative_kinetic,
            after_joules: 0.0,
            radiation_joules: relative_kinetic,
            check: energy_check,
        },
        accreted_material_masses_kg: materials,
        limits: ConservationLimits {
            mass: 1e-12,
            linear_momentum: 1e-10,
            angular_momentum: 1e-8,
            energy: 1e-6,
        },
        passed,
    })
}

fn resolve_black_hole(input: &CollisionInput) -> Result<EventResolution, KernelError> {
    let first = &input.first_body;
    let second = &input.second_body;
    if first.collision_model == CollisionModel::Stellar
        || second.collision_model == CollisionModel::Stellar
    {
        return Err(KernelError::new(
            ErrorCode::UnsupportedStellarCollision,
            Some(&input.event_id),
            "恒星与黑洞碰撞超出工程确定性 v1 范围",
        ));
    }
    if first.collision_model != CollisionModel::BlackHole
        && second.collision_model != CollisionModel::BlackHole
    {
        return Err(KernelError::new(
            ErrorCode::UnsupportedCollisionDomain,
            Some(&input.event_id),
            "blackHoleAccretion domain 至少需要一个黑洞参与体",
        ));
    }
    compute_contact(first, second).map_err(|message| numerical_error(input, message))?;
    let frame = center_of_mass(first, second).map_err(|message| numerical_error(input, message))?;
    let remnant_id = fragment_id(&input.event_id, &first.id, &second.id, "major");
    let black_hole_radius =
        finite(2.0 * GRAVITATIONAL_CONSTANT * frame.mass_kg / SPEED_OF_LIGHT.powi(2))
            .map_err(|message| numerical_error(input, message))?;
    let remnant = Body {
        id: remnant_id,
        mass_kg: frame.mass_kg,
        radius_meters: black_hole_radius,
        position_meters: frame.position,
        velocity_meters_per_second: frame.velocity,
        spin_angular_momentum_kg_meters_squared_per_second: total_angular_momentum(
            first, second, frame,
        )
        .map_err(|message| numerical_error(input, message))?,
        moment_of_inertia_factor: None,
        material_layers: vec![],
        collision_model: CollisionModel::BlackHole,
    };
    let ledger = compute_black_hole_ledger(input, &remnant, frame)?;
    if !ledger.passed {
        return Err(KernelError::new(
            ErrorCode::CollisionConservationFailed,
            Some(&input.event_id),
            "黑洞吞噬未通过牛顿守恒账本",
        ));
    }
    let participant_body_ids = if first.id.as_bytes() < second.id.as_bytes() {
        [first.id.clone(), second.id.clone()]
    } else {
        [second.id.clone(), first.id.clone()]
    };
    Ok(EventResolution::BlackHoleAccretion {
        event_id: input.event_id.clone(),
        participant_body_ids,
        remnant: remnant.clone(),
        after: EventState {
            major_bodies: vec![remnant],
            ..EventState::default()
        },
        ledger,
        approximations: ["blackHoleAccretion"],
    })
}

fn resolution_ids(resolution: &EventResolution) -> Vec<&str> {
    match resolution {
        EventResolution::Classic {
            major_remnant_ids,
            tracer_ids,
            dust_cohort_ids,
            ..
        } => major_remnant_ids
            .iter()
            .chain(tracer_ids)
            .chain(dust_cohort_ids)
            .map(String::as_str)
            .collect(),
        EventResolution::BlackHoleAccretion { remnant, .. } => vec![&remnant.id],
    }
}

pub(crate) fn resolve_batch(request: &BatchRequest) -> Result<Vec<EventResolution>, KernelError> {
    let mut remaining_major = request.capacity.major_remnant_slots as usize;
    let mut remaining_passive = request.capacity.passive_asset_slots as usize;
    let mut participant_owner = BTreeMap::new();
    for event in &request.events {
        let input = event.input();
        participant_owner.insert(input.first_body.id.as_str(), input.event_id.as_str());
        participant_owner.insert(input.second_body.id.as_str(), input.event_id.as_str());
    }
    let mut events: Vec<_> = request.events.iter().collect();
    events.sort_by(|left, right| {
        left.input()
            .event_id
            .as_bytes()
            .cmp(right.input().event_id.as_bytes())
    });
    let mut output_ids = BTreeSet::new();
    let mut resolutions = Vec::with_capacity(events.len());
    for event in events {
        let input = event.input();
        let resolution = match event {
            EventRequest::Classic {
                expected_material_profile,
                ..
            } => resolve_classic(input, *expected_material_profile)?,
            EventRequest::BlackHoleAccretion { .. } => resolve_black_hole(input)?,
        };
        let state = resolution.state();
        let major_count = state.major_bodies.len();
        let passive_count = state.tracers.len() + state.dust_cohorts.len();
        if major_count > remaining_major || passive_count > remaining_passive {
            return Err(KernelError::new(
                ErrorCode::CollisionCapacityExceeded,
                Some(&input.event_id),
                "碰撞结果超出本批次剩余主要残体或被动资产容量",
            ));
        }
        remaining_major -= major_count;
        remaining_passive -= passive_count;
        let preserves_participants = matches!(
            &resolution,
            EventResolution::Classic { candidate, .. }
                if candidate.classification == Classification::HitAndRun
        );
        for id in resolution_ids(&resolution) {
            let preserves_own = preserves_participants
                && participant_owner.get(id).copied() == Some(input.event_id.as_str());
            if !output_ids.insert(id.to_owned())
                || (participant_owner.contains_key(id) && !preserves_own)
            {
                return Err(KernelError::new(
                    ErrorCode::DuplicateOutputId,
                    Some(&input.event_id),
                    format!("输出资产 id 重复：{id}"),
                ));
            }
        }
        resolutions.push(resolution);
    }
    Ok(resolutions)
}

#[cfg(test)]
mod tests {
    use crate::model::{ContactQuantities, MaterialProfile};

    use super::{disruption, fragment_id, genda_ratio, largest_remnant_fraction};

    #[test]
    fn locks_universal_law_golden_values() {
        assert_eq!(largest_remnant_fraction(0.5), 0.75);
        assert_eq!(largest_remnant_fraction(1.0), 0.5);
        assert!((largest_remnant_fraction(3.0) - 0.046475800154489).abs() < 1e-14);
    }

    #[test]
    fn fragment_ids_ignore_parent_order() {
        let expected = "major-2176ff048d1ff719";
        assert_eq!(
            fragment_id("event", "parent-b", "parent-a", "major"),
            expected
        );
        assert_eq!(
            fragment_id("event", "parent-a", "parent-b", "major"),
            expected
        );
    }

    #[test]
    fn locks_disruption_and_genda_golden_values() {
        let total_mass = (4.0 / 3.0) * std::f64::consts::PI * 1_000.0 * 1_000_000_f64.powi(3);
        let contact = ContactQuantities {
            target_body_id: "target".into(),
            projectile_body_id: "projectile".into(),
            target_mass_kg: total_mass / 2.0,
            projectile_mass_kg: total_mass / 2.0,
            target_radius_meters: 500_000.0,
            projectile_radius_meters: 500_000.0,
            total_mass_kg: total_mass,
            reduced_mass_kg: total_mass / 4.0,
            interacting_reduced_mass_kg: total_mass / 4.0,
            mass_ratio: 1.0,
            center_distance_meters: 1_000_000.0,
            radius_sum_meters: 1_000_000.0,
            impact_speed_meters_per_second: 1.0,
            mutual_escape_speed_meters_per_second: 1.0,
            specific_impact_energy_joules_per_kg: 0.0,
            impact_angle_radians: 0.0,
            impact_parameter: 0.0,
            critical_impact_parameter: 0.5,
            interacting_length_meters: 1_000_000.0,
            interacting_projectile_fraction: 1.0,
            grazing: false,
        };
        let result = disruption(&contact, MaterialProfile::GravitySolid).expect("golden input");
        assert!((result.equivalent_combined_radius_meters - 1_000_000.0).abs() < 1e-9);
        assert!(
            (result.principal_disruption_threshold_joules_per_kg - 838_717.273_914_174_2).abs()
                < 1e-8
        );
        assert!(
            (result.critical_impact_speed_meters_per_second - 2_590.316_233_843_5).abs() < 1e-9
        );
        assert!((genda_ratio(1.0, 0.5) - 1.408_804_653_252).abs() < 1e-12);
    }
}
