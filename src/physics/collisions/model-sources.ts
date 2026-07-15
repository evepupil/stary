export const COLLISION_MODEL_VERSION = 'stary-edacm-v1' as const;
export const COLLISION_LEDGER_VERSION = 1 as const;

export const COLLISION_MODEL_SOURCES = {
  genda2012: {
    arxiv: '1109.4330v1',
    doi: '10.1088/0004-637X/744/2/137',
    equations: [8, 16],
    title: 'Merging Criteria for Giant Impacts of Protoplanets',
  },
  leinhardtStewart2012: {
    arxiv: '1106.6084v3',
    doi: '10.1088/0004-637X/745/1/79',
    equations: [1, 5, 6, 7, 11, 12, 15, 22, 23, 28, 30, 44],
    title: 'Collisions Between Gravity-Dominated Bodies. I. Outcome Regimes and Scaling Laws',
  },
} as const;

export const REFERENCE_DENSITY_KG_PER_CUBIC_METER = 1_000;
export const UNIFORM_SPHERE_SELF_BINDING_FACTOR = 3 / 5;
export const SUPER_CATASTROPHIC_TRANSITION = 1.8;
export const SUPER_CATASTROPHIC_EXPONENT = -1.5;

export const COLLISION_MATERIAL_PROFILES = {
  gravityFluid: {
    cStar: 1.9,
    cStarSensitivityRange: [1.6, 2.2],
    muBar: 0.36,
    sourceEquation: 28,
  },
  gravitySolid: {
    cStar: 5,
    cStarSensitivityRange: [3, 7],
    muBar: 0.37,
    sourceEquation: 28,
  },
} as const;

export const GENDA_MERGING_COEFFICIENTS = {
  c1: 2.43,
  c2: -0.0408,
  c3: 1.86,
  c4: 1.08,
  c5: 2.5,
  sourceEquation: 16,
} as const;

export const GENDA_MODEL_SCOPE = {
  composition: '无自转、30% 铁核与 70% 硅酸盐地幔的岩质原行星',
  impactAngleDegrees: [0, 75],
  impactSpeedEscapeRatios: [1, 3],
  calibratedMassRatios: [1, 2 / 3, 1 / 2, 1 / 3, 1 / 4, 1 / 6, 1 / 9],
  minimumMassRatio: 1 / 9,
  maximumImpactParameter: Math.sin((75 * Math.PI) / 180),
  referenceEarthMassKg: 5.9722e24,
  referenceEarthMassSource: 'STARY JPL J2000 Earth mass constant',
  totalMassEarthMasses: [0.2, 2],
  equalityClassifiesAsMerge: true,
} as const;

export const LEINHARDT_STEWART_OBLIQUITY_SCOPE = {
  minimumInteractingProjectileFractionExclusive: 0.5,
  description: 'LS2012 斜碰破坏标度的拟合讨论限定 alpha > 0.5；边界及更小值标记为外推',
  source: 'Leinhardt & Stewart 2012 Appendix',
} as const;

export const COLLISION_MODEL_APPROXIMATIONS = {
  classicalSelfBinding: {
    factor: UNIFORM_SPHERE_SELF_BINDING_FACTOR,
    description: 'Task 1 对经典球形天体使用均匀球自束缚能；分层密度积分留给后续模型版本',
    source: 'Leinhardt & Stewart 2012 Eq.27',
  },
  passiveGravity: {
    description: 'tracer 与 dust cohort 不互相施力，也不向主要天体施加反作用',
  },
} as const;

export const COLLISION_CONSERVATION_LIMITS = {
  angularMomentum: 1e-8,
  energy: 1e-6,
  linearMomentum: 1e-10,
  mass: 1e-12,
} as const;

export const MATERIAL_FRACTION_TOLERANCE = 1e-12;
export const MAX_COLLISION_MAJOR_REMNANTS = 64;
export const MAX_COLLISION_MAJOR_BODIES = 512;
export const MAX_COLLISION_PASSIVE_ASSETS = 10_000;
