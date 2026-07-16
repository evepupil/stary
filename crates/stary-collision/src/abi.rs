use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::COLLISION_ABI_VERSION;
use crate::kernel::resolve_json;

const MAX_REQUEST_BYTES: usize = 1_048_576;
const MAX_RESPONSE_BYTES: usize = 16_777_216;

const STATUS_OK: u32 = 0;
const STATUS_INVALID_STATE: u32 = 1;
const STATUS_LIMIT_EXCEEDED: u32 = 2;
const STATUS_ALLOCATION_FAILED: u32 = 3;

enum BufferState {
    Fresh,
    Request(Vec<u8>),
    Resolving,
    Response(Vec<u8>),
}

struct Registry {
    next_token: u32,
    contexts: BTreeMap<u32, BufferState>,
}

static REGISTRY: Mutex<Registry> = Mutex::new(Registry {
    next_token: 1,
    contexts: BTreeMap::new(),
});

#[unsafe(no_mangle)]
pub extern "C" fn stary_collision_abi_version() -> u32 {
    COLLISION_ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn stary_collision_create() -> u32 {
    let Ok(mut registry) = REGISTRY.lock() else {
        return 0;
    };
    let token = registry.next_token;
    if token == 0 {
        return 0;
    }
    let Some(next_token) = token.checked_add(1) else {
        registry.next_token = 0;
        return 0;
    };
    registry.next_token = next_token;
    registry.contexts.insert(token, BufferState::Fresh);
    token
}

#[unsafe(no_mangle)]
pub extern "C" fn stary_collision_alloc(token: u32, byte_length: u32) -> u32 {
    let length = byte_length as usize;
    if length == 0 || length > MAX_REQUEST_BYTES {
        return STATUS_LIMIT_EXCEEDED;
    }
    let Ok(mut registry) = REGISTRY.lock() else {
        return STATUS_INVALID_STATE;
    };
    let Some(state) = registry.contexts.get_mut(&token) else {
        return STATUS_INVALID_STATE;
    };
    if !matches!(state, BufferState::Fresh) {
        return STATUS_INVALID_STATE;
    }
    let mut buffer = Vec::new();
    if buffer.try_reserve_exact(length).is_err() {
        return STATUS_ALLOCATION_FAILED;
    }
    buffer.resize(length, 0);
    *state = BufferState::Request(buffer);
    STATUS_OK
}

#[unsafe(no_mangle)]
pub extern "C" fn stary_collision_buffer_ptr(token: u32) -> u32 {
    let Ok(registry) = REGISTRY.lock() else {
        return 0;
    };
    match registry.contexts.get(&token) {
        Some(BufferState::Request(buffer) | BufferState::Response(buffer))
            if !buffer.is_empty() =>
        {
            buffer.as_ptr() as usize as u32
        }
        _ => 0,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn stary_collision_buffer_len(token: u32) -> u32 {
    let Ok(registry) = REGISTRY.lock() else {
        return 0;
    };
    match registry.contexts.get(&token) {
        Some(BufferState::Request(buffer) | BufferState::Response(buffer)) => buffer.len() as u32,
        _ => 0,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn stary_collision_resolve(token: u32) -> u32 {
    let request = {
        let Ok(mut registry) = REGISTRY.lock() else {
            return STATUS_INVALID_STATE;
        };
        let Some(state) = registry.contexts.get_mut(&token) else {
            return STATUS_INVALID_STATE;
        };
        match std::mem::replace(state, BufferState::Resolving) {
            BufferState::Request(request) => request,
            other => {
                *state = other;
                return STATUS_INVALID_STATE;
            }
        }
    };

    let response = resolve_json(&request);
    if response.is_empty() || response.len() > MAX_RESPONSE_BYTES {
        if let Ok(mut registry) = REGISTRY.lock()
            && let Some(state) = registry.contexts.get_mut(&token)
            && matches!(state, BufferState::Resolving)
        {
            *state = BufferState::Fresh;
        }
        return STATUS_LIMIT_EXCEEDED;
    }
    let Ok(mut registry) = REGISTRY.lock() else {
        return STATUS_INVALID_STATE;
    };
    let Some(state) = registry.contexts.get_mut(&token) else {
        return STATUS_INVALID_STATE;
    };
    if !matches!(state, BufferState::Resolving) {
        return STATUS_INVALID_STATE;
    }
    *state = BufferState::Response(response);
    STATUS_OK
}

#[unsafe(no_mangle)]
pub extern "C" fn stary_collision_destroy(token: u32) -> u32 {
    let Ok(mut registry) = REGISTRY.lock() else {
        return STATUS_INVALID_STATE;
    };
    if registry.contexts.remove(&token).is_some() {
        STATUS_OK
    } else {
        STATUS_INVALID_STATE
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn stary_collision_live_count() -> u32 {
    let Ok(registry) = REGISTRY.lock() else {
        return 0;
    };
    registry.contexts.len().try_into().unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::{
        STATUS_INVALID_STATE, STATUS_LIMIT_EXCEEDED, STATUS_OK, stary_collision_alloc,
        stary_collision_create, stary_collision_destroy, stary_collision_live_count,
        stary_collision_resolve,
    };

    #[test]
    fn stale_and_repeated_handles_do_not_touch_new_contexts() {
        let baseline = stary_collision_live_count();
        let first = stary_collision_create();
        assert_ne!(first, 0);
        assert_eq!(stary_collision_destroy(first), STATUS_OK);
        assert_eq!(stary_collision_destroy(first), STATUS_INVALID_STATE);
        let second = stary_collision_create();
        assert_ne!(second, first);
        assert_eq!(stary_collision_destroy(first), STATUS_INVALID_STATE);
        assert_eq!(stary_collision_live_count(), baseline + 1);
        assert_eq!(stary_collision_destroy(second), STATUS_OK);
    }

    #[test]
    fn enforces_state_machine_and_request_limit() {
        let token = stary_collision_create();
        assert_eq!(stary_collision_resolve(token), STATUS_INVALID_STATE);
        assert_eq!(stary_collision_alloc(token, 0), STATUS_LIMIT_EXCEEDED);
        assert_eq!(stary_collision_alloc(token, 16), STATUS_OK);
        assert_eq!(stary_collision_alloc(token, 16), STATUS_INVALID_STATE);
        assert_eq!(stary_collision_destroy(token), STATUS_OK);
    }
}
