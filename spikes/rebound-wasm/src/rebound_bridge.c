#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "rebound.h"
#include "rebound_contact.h"

struct stary_reb_handle {
    struct reb_simulation* simulation;
    struct stary_contact_state contact;
    uintptr_t token;
    struct stary_reb_handle* next;
};

static struct stary_reb_handle* stary_handles = NULL;
static uintptr_t stary_next_handle_token = 1;

static struct stary_reb_handle* stary_handle(uintptr_t raw_handle) {
    struct stary_reb_handle* current = stary_handles;
    while (current != NULL) {
        if (current->token == raw_handle) {
            return current;
        }
        current = current->next;
    }
    return NULL;
}

static int stary_valid_handle(const struct stary_reb_handle* handle) {
    return handle != NULL && handle->simulation != NULL;
}

uintptr_t stary_reb_create(double gravitational_constant) {
    if (!isfinite(gravitational_constant) || gravitational_constant <= 0.0) {
        return 0;
    }
    struct stary_reb_handle* handle = calloc(1, sizeof(*handle));
    if (handle == NULL) {
        return 0;
    }
    handle->simulation = reb_simulation_create();
    if (handle->simulation == NULL) {
        free(handle);
        return 0;
    }
    handle->simulation->G = gravitational_constant;
    handle->simulation->save_messages = 1;
    stary_contact_state_init(&handle->contact);
    handle->token = stary_next_handle_token++;
    if (stary_next_handle_token == 0) {
        stary_next_handle_token = 1;
    }
    handle->next = stary_handles;
    stary_handles = handle;
    return handle->token;
}

void stary_reb_destroy(uintptr_t raw_handle) {
    struct stary_reb_handle** link = &stary_handles;
    while (*link != NULL && (*link)->token != raw_handle) {
        link = &(*link)->next;
    }
    struct stary_reb_handle* handle = *link;
    if (handle == NULL) {
        return;
    }
    *link = handle->next;
    if (handle->simulation != NULL) {
        reb_simulation_free(handle->simulation);
    }
    stary_contact_state_destroy(&handle->contact);
    free(handle);
}

int stary_reb_reset(uintptr_t raw_handle, double gravitational_constant) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    if (!stary_valid_handle(handle)) {
        return -1;
    }
    if (!isfinite(gravitational_constant) || gravitational_constant <= 0.0) {
        return -2;
    }
    struct reb_simulation* replacement = reb_simulation_create();
    if (replacement == NULL) {
        return -4;
    }
    replacement->G = gravitational_constant;
    replacement->save_messages = 1;
    reb_simulation_free(handle->simulation);
    handle->simulation = replacement;
    stary_contact_state_clear(&handle->contact);
    return 0;
}

int stary_reb_add_particle(
    uintptr_t raw_handle,
    double mass,
    double radius,
    double x,
    double y,
    double z,
    double vx,
    double vy,
    double vz
) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    if (!stary_valid_handle(handle)) {
        return -1;
    }
    if (handle->contact.pending) {
        return STARY_CONTACT_ERROR_PENDING;
    }
    const double values[] = {mass, radius, x, y, z, vx, vy, vz};
    for (size_t index = 0; index < sizeof(values) / sizeof(values[0]); index++) {
        if (!isfinite(values[index])) {
            return -2;
        }
    }
    if (mass < 0.0 || radius < 0.0) {
        return -2;
    }
    struct reb_particle particle;
    memset(&particle, 0, sizeof(particle));
    particle.m = mass;
    particle.r = radius;
    particle.x = x;
    particle.y = y;
    particle.z = z;
    particle.vx = vx;
    particle.vy = vy;
    particle.vz = vz;
    reb_simulation_add(handle->simulation, particle);
    stary_contact_state_clear(&handle->contact);
    return 0;
}

int stary_reb_set_integrator(uintptr_t raw_handle, int integrator, double timestep) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    if (!stary_valid_handle(handle)) {
        return -1;
    }
    if (handle->contact.pending) {
        return STARY_CONTACT_ERROR_PENDING;
    }
    if (!isfinite(timestep) || timestep <= 0.0) {
        return -2;
    }
    const char* name = integrator == 0 ? "ias15" : integrator == 1 ? "whfast" : NULL;
    if (name == NULL || reb_simulation_set_integrator(handle->simulation, name) == NULL) {
        return -5;
    }
    handle->simulation->dt = timestep;
    stary_contact_state_clear(&handle->contact);
    return 0;
}

int stary_reb_move_to_com(uintptr_t raw_handle) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    if (!stary_valid_handle(handle)) {
        return -1;
    }
    if (handle->contact.pending) {
        return STARY_CONTACT_ERROR_PENDING;
    }
    reb_simulation_move_to_com(handle->simulation);
    stary_contact_state_clear(&handle->contact);
    return 0;
}

int stary_reb_integrate(uintptr_t raw_handle, double target_time) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    if (!stary_valid_handle(handle)) {
        return -1;
    }
    if (handle->contact.pending) {
        return STARY_CONTACT_ERROR_PENDING;
    }
    if (!isfinite(target_time) || target_time < handle->simulation->t) {
        return -2;
    }
    return (int)reb_simulation_integrate(handle->simulation, target_time);
}

int stary_reb_advance_until_event(uintptr_t raw_handle, double target_time) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    if (!stary_valid_handle(handle)) {
        return -1;
    }
    return stary_contact_advance(&handle->simulation, &handle->contact, target_time);
}

int stary_reb_contact_count(uintptr_t raw_handle) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    if (!stary_valid_handle(handle) || !handle->contact.pending) {
        return -1;
    }
    return (int)handle->contact.pair_count;
}

double stary_reb_contact_time(uintptr_t raw_handle) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    return stary_valid_handle(handle) && handle->contact.pending ? handle->contact.time : NAN;
}

int stary_reb_contact_particle_index(
    uintptr_t raw_handle,
    int pair_index,
    int member_index
) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    if (!stary_valid_handle(handle) || !handle->contact.pending || pair_index < 0 ||
        (size_t)pair_index >= handle->contact.pair_count) {
        return -1;
    }
    if (member_index == 0) {
        return handle->contact.pairs[pair_index].first_particle_index;
    }
    if (member_index == 1) {
        return handle->contact.pairs[pair_index].second_particle_index;
    }
    return -1;
}

int stary_reb_clear_contact(uintptr_t raw_handle) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    if (!stary_valid_handle(handle)) {
        return -1;
    }
    stary_contact_state_acknowledge(&handle->contact);
    return 0;
}

int stary_reb_discard_contact(uintptr_t raw_handle) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    if (!stary_valid_handle(handle)) {
        return -1;
    }
    stary_contact_state_discard(&handle->contact);
    return 0;
}

int stary_reb_temporary_copy_count(uintptr_t raw_handle) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    if (!stary_valid_handle(handle)) {
        return -1;
    }
    return (int)handle->contact.temporary_copy_count;
}

int stary_reb_particle_count(uintptr_t raw_handle) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    return stary_valid_handle(handle) ? (int)handle->simulation->N : -1;
}

double stary_reb_get_time(uintptr_t raw_handle) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    return stary_valid_handle(handle) ? handle->simulation->t : NAN;
}

double stary_reb_get_particle_value(uintptr_t raw_handle, int particle_index, int component) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    if (!stary_valid_handle(handle) || particle_index < 0 || (size_t)particle_index >= handle->simulation->N) {
        return NAN;
    }
    const struct reb_particle* particle = &handle->simulation->particles[particle_index];
    switch (component) {
        case 0: return particle->m;
        case 1: return particle->r;
        case 2: return particle->x;
        case 3: return particle->y;
        case 4: return particle->z;
        case 5: return particle->vx;
        case 6: return particle->vy;
        case 7: return particle->vz;
        default: return NAN;
    }
}

double stary_reb_energy(uintptr_t raw_handle) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    return stary_valid_handle(handle) ? reb_simulation_energy(handle->simulation) : NAN;
}

double stary_reb_angular_momentum_value(uintptr_t raw_handle, int component) {
    struct stary_reb_handle* handle = stary_handle(raw_handle);
    if (!stary_valid_handle(handle)) {
        return NAN;
    }
    const struct reb_vec3d momentum = reb_simulation_angular_momentum(handle->simulation);
    switch (component) {
        case 0: return momentum.x;
        case 1: return momentum.y;
        case 2: return momentum.z;
        default: return NAN;
    }
}
