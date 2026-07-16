use crate::COLLISION_ABI_VERSION;
use crate::model::{
    BatchRequest, ErrorCode, ErrorDetail, KernelError, MODEL_VERSION, RECONSTRUCTION_VERSION,
    Response,
};
use crate::physics::{resolve_batch, validate_request};

fn error_response(error: KernelError) -> Response {
    Response::Error {
        abi_version: COLLISION_ABI_VERSION,
        model_version: MODEL_VERSION,
        reconstruction_version: RECONSTRUCTION_VERSION,
        error: ErrorDetail {
            code: error.code,
            event_id: error.event_id,
            message: truncate_message(error.message),
        },
    }
}

fn truncate_message(message: String) -> String {
    if message.encode_utf16().count() <= 512 {
        return message;
    }
    message.chars().take(512).collect()
}

pub(crate) fn resolve_json(request_bytes: &[u8]) -> Vec<u8> {
    let response = match serde_json::from_slice::<BatchRequest>(request_bytes) {
        Ok(request) => match validate_request(&request) {
            Ok(()) => match resolve_batch(&request) {
                Ok(events) => Response::Success {
                    abi_version: COLLISION_ABI_VERSION,
                    model_version: MODEL_VERSION,
                    reconstruction_version: RECONSTRUCTION_VERSION,
                    events,
                },
                Err(error) => error_response(error),
            },
            Err(error) => error_response(error),
        },
        Err(error) => error_response(KernelError::new(
            ErrorCode::MalformedInput,
            None,
            error.to_string(),
        )),
    };
    serde_json::to_vec(&response).unwrap_or_else(|_| {
        r#"{"abiVersion":1,"modelVersion":"stary-edacm-v1","reconstructionVersion":"stary-deterministic-v1","kind":"error","error":{"code":"collisionNumericalFailure","eventId":null,"message":"碰撞内核响应编码失败"}}"#
            .as_bytes()
            .to_vec()
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::resolve_json;

    fn body_with_velocity(
        id: &str,
        mass: f64,
        radius: f64,
        x: f64,
        velocity_x: f64,
        velocity_y: f64,
    ) -> Value {
        json!({
            "id": id,
            "massKg": mass,
            "radiusMeters": radius,
            "positionMeters": { "x": x, "y": 0.0, "z": 0.0 },
            "velocityMetersPerSecond": { "x": velocity_x, "y": velocity_y, "z": 0.0 },
            "spinAngularMomentumKgMetersSquaredPerSecond": { "x": 0.0, "y": 0.0, "z": 0.0 },
            "momentOfInertiaFactor": 0.4,
            "materialLayers": [{ "material": "silicate", "massFraction": 1.0 }],
            "collisionModel": "gravitySolid"
        })
    }

    fn body(id: &str, mass: f64, radius: f64, x: f64, velocity_x: f64) -> Value {
        body_with_velocity(id, mass, radius, x, velocity_x, 0.0)
    }

    fn request() -> Value {
        json!({
            "abiVersion": 1,
            "modelVersion": "stary-edacm-v1",
            "reconstructionVersion": "stary-deterministic-v1",
            "capacity": { "majorRemnantSlots": 1, "passiveAssetSlots": 0 },
            "events": [{
                "domain": "classic",
                "input": {
                    "eventId": "event-merge",
                    "simulationTimeSeconds": 42.0,
                    "firstBody": body("target", 4e21, 700_000.0, 0.0, 0.0),
                    "secondBody": body("projectile", 2e21, 500_000.0, 1_200_000.0, -1.0)
                },
                "expectedMaterialProfile": "gravitySolid"
            }]
        })
    }

    #[test]
    fn resolves_a_classic_merge_batch() {
        let response: Value =
            serde_json::from_slice(&resolve_json(&serde_json::to_vec(&request()).unwrap()))
                .expect("response JSON must parse");
        assert_eq!(response["kind"], "success");
        assert_eq!(
            response["events"][0]["candidate"]["classification"],
            "merge"
        );
        assert_eq!(
            response["events"][0]["after"]["majorBodies"][0]["massKg"],
            6e21
        );
        assert_eq!(response["events"][0]["ledger"]["passed"], true);
    }

    #[test]
    fn malformed_and_capacity_errors_are_envelopes() {
        let malformed: Value = serde_json::from_slice(&resolve_json(br#"{"unexpected":true}"#))
            .expect("error response must parse");
        assert_eq!(malformed["error"]["code"], "malformedInput");

        let mut capacity = request();
        capacity["capacity"]["majorRemnantSlots"] = json!(0);
        let response: Value = serde_json::from_slice(&resolve_json(
            &serde_json::to_vec(&capacity).expect("request must serialize"),
        ))
        .expect("error response must parse");
        assert_eq!(response["error"]["code"], "collisionCapacityExceeded");
        assert_eq!(response["error"]["eventId"], "event-merge");
    }

    #[test]
    fn rejects_unknown_fields_and_shared_participants() {
        let mut unknown = request();
        unknown["unexpected"] = json!(true);
        let response: Value = serde_json::from_slice(&resolve_json(
            &serde_json::to_vec(&unknown).expect("request must serialize"),
        ))
        .expect("error response must parse");
        assert_eq!(response["error"]["code"], "malformedInput");

        let mut shared = request();
        let second = shared["events"][0].clone();
        shared["events"].as_array_mut().unwrap().push(second);
        let response: Value = serde_json::from_slice(&resolve_json(
            &serde_json::to_vec(&shared).expect("request must serialize"),
        ))
        .expect("error response must parse");
        assert_eq!(response["error"]["code"], "malformedInput");
    }

    #[test]
    fn resolves_hit_and_run_and_stably_sorts_batches() {
        let target_mass: f64 = 4e24;
        let projectile_mass: f64 = 2e24;
        let radius_sum: f64 = 12e6;
        let escape_speed =
            ((2.0 * 6.6743e-11 * (target_mass + projectile_mass)) / radius_sum).sqrt();
        let speed = 1.5 * escape_speed;
        let event = |event_id: &str, prefix: &str| {
            json!({
                "domain": "classic",
                "input": {
                    "eventId": event_id,
                    "simulationTimeSeconds": 42.0,
                    "firstBody": body_with_velocity(&format!("{prefix}-target"), target_mass, 7e6, 0.0, 0.0, 0.0),
                    "secondBody": body_with_velocity(&format!("{prefix}-projectile"), projectile_mass, 5e6, radius_sum, -speed * 0.6, speed * 0.8)
                },
                "expectedMaterialProfile": "gravitySolid"
            })
        };
        let request = json!({
            "abiVersion": 1,
            "modelVersion": "stary-edacm-v1",
            "reconstructionVersion": "stary-deterministic-v1",
            "capacity": { "majorRemnantSlots": 4, "passiveAssetSlots": 0 },
            "events": [event("z-event", "z"), event("a-event", "a")]
        });
        let response: Value =
            serde_json::from_slice(&resolve_json(&serde_json::to_vec(&request).unwrap()))
                .expect("response must parse");
        assert_eq!(response["kind"], "success");
        assert_eq!(response["events"][0]["eventId"], "a-event");
        assert_eq!(response["events"][1]["eventId"], "z-event");
        assert_eq!(
            response["events"][0]["candidate"]["classification"],
            "hitAndRun"
        );
        assert_eq!(
            response["events"][0]["after"]["majorBodies"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(response["events"][0]["ledger"]["passed"], true);
    }

    #[test]
    fn resolves_catastrophic_disruption_into_dust() {
        let request = json!({
            "abiVersion": 1,
            "modelVersion": "stary-edacm-v1",
            "reconstructionVersion": "stary-deterministic-v1",
            "capacity": { "majorRemnantSlots": 1, "passiveAssetSlots": 1 },
            "events": [{
                "domain": "classic",
                "input": {
                    "eventId": "event-catastrophic",
                    "simulationTimeSeconds": 42.0,
                    "firstBody": body("target", 4e21, 700_000.0, 0.0, 0.0),
                    "secondBody": body("projectile", 2e21, 500_000.0, 1_200_000.0, -7_000.0)
                },
                "expectedMaterialProfile": "gravitySolid"
            }]
        });
        let response: Value =
            serde_json::from_slice(&resolve_json(&serde_json::to_vec(&request).unwrap()))
                .expect("response must parse");
        assert_eq!(response["kind"], "success", "{response:#}");
        assert!(matches!(
            response["events"][0]["candidate"]["classification"].as_str(),
            Some("catastrophicDisruption" | "superCatastrophicDisruption")
        ));
        assert_eq!(
            response["events"][0]["after"]["dustCohorts"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(response["events"][0]["ledger"]["passed"], true);
    }

    #[test]
    fn resolves_black_hole_accretion_with_material_ledger() {
        let black_hole = json!({
            "id": "black-hole",
            "massKg": 5e24,
            "radiusMeters": 0.01,
            "positionMeters": { "x": 0.0, "y": 0.0, "z": 0.0 },
            "velocityMetersPerSecond": { "x": 0.0, "y": 0.0, "z": 0.0 },
            "spinAngularMomentumKgMetersSquaredPerSecond": { "x": 0.0, "y": 0.0, "z": 1e20 },
            "momentOfInertiaFactor": null,
            "materialLayers": [],
            "collisionModel": "blackHole"
        });
        let mut planet = body("planet", 1e20, 100_000.0, 100_000.01, -1_000.0);
        planet["velocityMetersPerSecond"]["y"] = json!(100.0);
        planet["materialLayers"] = json!([
            { "material": "silicate", "massFraction": 0.7 },
            { "material": "iron", "massFraction": 0.3 }
        ]);
        let request = json!({
            "abiVersion": 1,
            "modelVersion": "stary-edacm-v1",
            "reconstructionVersion": "stary-deterministic-v1",
            "capacity": { "majorRemnantSlots": 1, "passiveAssetSlots": 0 },
            "events": [{
                "domain": "blackHoleAccretion",
                "input": {
                    "eventId": "event-black-hole",
                    "simulationTimeSeconds": 7.0,
                    "firstBody": black_hole,
                    "secondBody": planet
                },
                "expectedMaterialProfile": null
            }]
        });
        let response: Value =
            serde_json::from_slice(&resolve_json(&serde_json::to_vec(&request).unwrap()))
                .expect("response must parse");
        assert_eq!(response["kind"], "success", "{response:#}");
        assert_eq!(response["events"][0]["domain"], "blackHoleAccretion");
        let remnant_mass = response["events"][0]["remnant"]["massKg"]
            .as_f64()
            .expect("remnant mass must be numeric");
        assert_eq!(remnant_mass, 5e24 + 1e20);
        assert_eq!(response["events"][0]["ledger"]["passed"], true);
        let silicate = response["events"][0]["ledger"]["accretedMaterialMassesKg"]["silicate"]
            .as_f64()
            .expect("silicate mass must be numeric");
        assert!((silicate / 1e20 - 0.7).abs() < 1e-15);
    }
}
