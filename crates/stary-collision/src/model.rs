use serde::{Deserialize, Serialize};

pub const MODEL_VERSION: &str = "stary-edacm-v1";
pub const RECONSTRUCTION_VERSION: &str = "stary-deterministic-v1";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum Material {
    #[serde(rename = "gas")]
    Gas,
    #[serde(rename = "ice")]
    Ice,
    #[serde(rename = "silicate")]
    Silicate,
    #[serde(rename = "iron")]
    Iron,
}

impl Material {
    pub const ALL: [Self; 4] = [Self::Gas, Self::Ice, Self::Silicate, Self::Iron];

    pub const fn index(self) -> usize {
        match self {
            Self::Gas => 0,
            Self::Ice => 1,
            Self::Silicate => 2,
            Self::Iron => 3,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum CollisionModel {
    #[serde(rename = "gravitySolid")]
    GravitySolid,
    #[serde(rename = "gravityFluid")]
    GravityFluid,
    #[serde(rename = "stellar")]
    Stellar,
    #[serde(rename = "blackHole")]
    BlackHole,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum MaterialProfile {
    #[serde(rename = "gravitySolid")]
    GravitySolid,
    #[serde(rename = "gravityFluid")]
    GravityFluid,
}

impl From<MaterialProfile> for CollisionModel {
    fn from(value: MaterialProfile) -> Self {
        match value {
            MaterialProfile::GravitySolid => Self::GravitySolid,
            MaterialProfile::GravityFluid => Self::GravityFluid,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Vector {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialLayer {
    pub material: Material,
    pub mass_fraction: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Body {
    pub id: String,
    pub mass_kg: f64,
    pub radius_meters: f64,
    pub position_meters: Vector,
    pub velocity_meters_per_second: Vector,
    pub spin_angular_momentum_kg_meters_squared_per_second: Vector,
    pub moment_of_inertia_factor: Option<f64>,
    pub material_layers: Vec<MaterialLayer>,
    pub collision_model: CollisionModel,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PassiveAsset {
    pub id: String,
    pub mass_kg: f64,
    pub position_meters: Vector,
    pub velocity_meters_per_second: Vector,
    pub material_layers: Vec<MaterialLayer>,
    pub subgrid_mechanical_energy_joules: f64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventState {
    pub major_bodies: Vec<Body>,
    pub tracers: Vec<PassiveAsset>,
    pub dust_cohorts: Vec<PassiveAsset>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollisionInput {
    pub event_id: String,
    pub simulation_time_seconds: f64,
    pub first_body: Body,
    pub second_body: Body,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "domain")]
pub enum EventRequest {
    #[serde(rename = "classic")]
    Classic {
        input: CollisionInput,
        #[serde(rename = "expectedMaterialProfile")]
        expected_material_profile: MaterialProfile,
    },
    #[serde(rename = "blackHoleAccretion")]
    BlackHoleAccretion {
        input: CollisionInput,
        #[serde(rename = "expectedMaterialProfile")]
        expected_material_profile: serde_json::Value,
    },
}

impl EventRequest {
    pub fn input(&self) -> &CollisionInput {
        match self {
            Self::Classic { input, .. } | Self::BlackHoleAccretion { input, .. } => input,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capacity {
    pub major_remnant_slots: u32,
    pub passive_asset_slots: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchRequest {
    pub abi_version: u32,
    pub model_version: String,
    pub reconstruction_version: String,
    pub capacity: Capacity,
    pub events: Vec<EventRequest>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactQuantities {
    pub target_body_id: String,
    pub projectile_body_id: String,
    pub target_mass_kg: f64,
    pub projectile_mass_kg: f64,
    pub target_radius_meters: f64,
    pub projectile_radius_meters: f64,
    pub total_mass_kg: f64,
    pub reduced_mass_kg: f64,
    pub interacting_reduced_mass_kg: f64,
    pub mass_ratio: f64,
    pub center_distance_meters: f64,
    pub radius_sum_meters: f64,
    pub impact_speed_meters_per_second: f64,
    pub mutual_escape_speed_meters_per_second: f64,
    pub specific_impact_energy_joules_per_kg: f64,
    pub impact_angle_radians: f64,
    pub impact_parameter: f64,
    pub critical_impact_parameter: f64,
    pub interacting_length_meters: f64,
    pub interacting_projectile_fraction: f64,
    pub grazing: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisruptionScaling {
    pub material_profile: MaterialProfile,
    pub equivalent_combined_radius_meters: f64,
    pub principal_disruption_threshold_joules_per_kg: f64,
    pub mass_ratio_scale: f64,
    pub head_on_disruption_threshold_joules_per_kg: f64,
    pub obliquity_scale: f64,
    pub obliquity_model_extrapolated: bool,
    pub disruption_threshold_joules_per_kg: f64,
    pub critical_impact_speed_meters_per_second: f64,
    pub normalized_impact_energy: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Classification {
    #[serde(rename = "merge")]
    Merge,
    #[serde(rename = "grazeAndMerge")]
    GrazeAndMerge,
    #[serde(rename = "hitAndRun")]
    HitAndRun,
    #[serde(rename = "partialAccretion")]
    PartialAccretion,
    #[serde(rename = "erosion")]
    Erosion,
    #[serde(rename = "catastrophicDisruption")]
    CatastrophicDisruption,
    #[serde(rename = "superCatastrophicDisruption")]
    SuperCatastrophicDisruption,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum ResolutionKind {
    #[serde(rename = "modeledCollision")]
    ModeledCollision,
    #[serde(rename = "nonInteractingTangent")]
    NonInteractingTangent,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub model_version: &'static str,
    pub resolution_kind: ResolutionKind,
    pub classification: Classification,
    pub contact: ContactQuantities,
    pub disruption: Option<DisruptionScaling>,
    pub largest_remnant_mass_fraction: Option<f64>,
    pub largest_remnant_mass_kg: Option<f64>,
    pub genda_critical_velocity_ratio: Option<f64>,
    pub genda_model_extrapolated: Option<bool>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dissipation {
    pub heat_joules: f64,
    pub deformation_joules: f64,
    pub fracture_joules: f64,
    pub radiation_joules: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct MaterialMasses {
    pub gas: f64,
    pub ice: f64,
    pub silicate: f64,
    pub iron: f64,
}

impl MaterialMasses {
    pub fn get(self, material: Material) -> f64 {
        match material {
            Material::Gas => self.gas,
            Material::Ice => self.ice,
            Material::Silicate => self.silicate,
            Material::Iron => self.iron,
        }
    }

    pub fn add(&mut self, material: Material, value: f64) {
        match material {
            Material::Gas => self.gas += value,
            Material::Ice => self.ice += value,
            Material::Silicate => self.silicate += value,
            Material::Iron => self.iron += value,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReservoirMasses {
    pub major_kg: f64,
    pub tracer_kg: f64,
    pub dust_kg: f64,
    pub total_kg: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MechanicalEnergy {
    pub translational_joules: f64,
    pub spin_joules: f64,
    pub active_active_potential_joules: f64,
    pub active_passive_potential_joules: f64,
    pub self_binding_joules: f64,
    pub subgrid_joules: f64,
    pub total_joules: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTotals {
    pub reservoir_masses: ReservoirMasses,
    pub material_masses_kg: MaterialMasses,
    pub linear_momentum_kg_meters_per_second: Vector,
    pub angular_momentum_kg_meters_squared_per_second: Vector,
    pub energy: MechanicalEnergy,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConservationCheck {
    pub absolute_error: f64,
    pub scale: f64,
    pub normalized_error: f64,
    pub threshold: f64,
    pub passed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MaterialChecks {
    pub gas: ConservationCheck,
    pub ice: ConservationCheck,
    pub silicate: ConservationCheck,
    pub iron: ConservationCheck,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerChecks {
    pub mass: ConservationCheck,
    pub material_masses: MaterialChecks,
    pub linear_momentum: ConservationCheck,
    pub angular_momentum: ConservationCheck,
    pub energy: ConservationCheck,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceFrame {
    pub origin_meters: Vector,
    pub velocity_meters_per_second: Vector,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollisionLedger {
    pub ledger_version: u32,
    pub model_version: &'static str,
    pub event_id: String,
    pub simulation_time_seconds: f64,
    pub reference_frame: ReferenceFrame,
    pub before: EventTotals,
    pub after: EventTotals,
    pub dissipation: Dissipation,
    pub checks: LedgerChecks,
    pub omitted_interaction_classes: [&'static str; 4],
    pub passed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlackHoleLedger {
    pub ledger_version: u32,
    pub model_version: &'static str,
    pub reconstruction_version: &'static str,
    pub event_id: String,
    pub simulation_time_seconds: f64,
    pub reference_frame: ReferenceFrame,
    pub energy_scope: &'static str,
    pub mass: ScalarLedgerEntry,
    pub linear_momentum: VectorLedgerEntry,
    pub angular_momentum: AngularLedgerEntry,
    pub relative_kinetic_energy: EnergyLedgerEntry,
    pub accreted_material_masses_kg: MaterialMasses,
    pub limits: ConservationLimits,
    pub passed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScalarLedgerEntry {
    pub before_kg: f64,
    pub after_kg: f64,
    pub check: ConservationCheck,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorLedgerEntry {
    pub before_kg_meters_per_second: Vector,
    pub after_kg_meters_per_second: Vector,
    pub check: ConservationCheck,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AngularLedgerEntry {
    pub before_kg_meters_squared_per_second: Vector,
    pub after_kg_meters_squared_per_second: Vector,
    pub check: ConservationCheck,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnergyLedgerEntry {
    pub before_joules: f64,
    pub after_joules: f64,
    pub radiation_joules: f64,
    pub check: ConservationCheck,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConservationLimits {
    pub mass: f64,
    pub linear_momentum: f64,
    pub angular_momentum: f64,
    pub energy: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "domain")]
pub enum EventResolution {
    #[serde(rename = "classic")]
    Classic {
        #[serde(rename = "eventId")]
        event_id: String,
        #[serde(rename = "participantBodyIds")]
        participant_body_ids: [String; 2],
        #[serde(rename = "expectedMaterialProfile")]
        expected_material_profile: MaterialProfile,
        #[serde(rename = "ledgerScope")]
        ledger_scope: &'static str,
        candidate: Candidate,
        after: EventState,
        dissipation: Dissipation,
        ledger: Box<CollisionLedger>,
        #[serde(rename = "majorRemnantIds")]
        major_remnant_ids: Vec<String>,
        #[serde(rename = "tracerIds")]
        tracer_ids: Vec<String>,
        #[serde(rename = "dustCohortIds")]
        dust_cohort_ids: Vec<String>,
        approximations: Vec<&'static str>,
    },
    #[serde(rename = "blackHoleAccretion")]
    BlackHoleAccretion {
        #[serde(rename = "eventId")]
        event_id: String,
        #[serde(rename = "participantBodyIds")]
        participant_body_ids: [String; 2],
        remnant: Body,
        after: EventState,
        ledger: BlackHoleLedger,
        approximations: [&'static str; 1],
    },
}

impl EventResolution {
    pub fn state(&self) -> &EventState {
        match self {
            Self::Classic { after, .. } | Self::BlackHoleAccretion { after, .. } => after,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum ErrorCode {
    #[serde(rename = "malformedInput")]
    MalformedInput,
    #[serde(rename = "unsupportedCollisionDomain")]
    UnsupportedCollisionDomain,
    #[serde(rename = "unsupportedStellarCollision")]
    UnsupportedStellarCollision,
    #[serde(rename = "unsupportedStrengthRegime")]
    UnsupportedStrengthRegime,
    #[serde(rename = "collisionCapacityExceeded")]
    CollisionCapacityExceeded,
    #[serde(rename = "collisionReconstructionFailed")]
    CollisionReconstructionFailed,
    #[serde(rename = "collisionConservationFailed")]
    CollisionConservationFailed,
    #[serde(rename = "collisionNumericalFailure")]
    CollisionNumericalFailure,
    #[serde(rename = "duplicateOutputId")]
    DuplicateOutputId,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetail {
    pub code: ErrorCode,
    pub event_id: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum Response {
    #[serde(rename = "success")]
    Success {
        #[serde(rename = "abiVersion")]
        abi_version: u32,
        #[serde(rename = "modelVersion")]
        model_version: &'static str,
        #[serde(rename = "reconstructionVersion")]
        reconstruction_version: &'static str,
        events: Vec<EventResolution>,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(rename = "abiVersion")]
        abi_version: u32,
        #[serde(rename = "modelVersion")]
        model_version: &'static str,
        #[serde(rename = "reconstructionVersion")]
        reconstruction_version: &'static str,
        error: ErrorDetail,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct KernelError {
    pub code: ErrorCode,
    pub event_id: Option<String>,
    pub message: String,
}

impl KernelError {
    pub fn new(code: ErrorCode, event_id: Option<&str>, message: impl Into<String>) -> Self {
        Self {
            code,
            event_id: event_id.map(str::to_owned),
            message: message.into(),
        }
    }
}
