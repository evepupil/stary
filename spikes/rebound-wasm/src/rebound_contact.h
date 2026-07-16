#ifndef STARY_REBOUND_CONTACT_H
#define STARY_REBOUND_CONTACT_H

#include <stddef.h>

#include "rebound.h"

#define STARY_CONTACT_ADVANCED 0
#define STARY_CONTACT_FOUND 1
#define STARY_CONTACT_ERROR_INVALID_TARGET -2
#define STARY_CONTACT_ERROR_PENDING -3
#define STARY_CONTACT_ERROR_ALLOCATION -4
#define STARY_CONTACT_ERROR_INTEGRATOR -5
#define STARY_CONTACT_ERROR_INTEGRATION -6
#define STARY_CONTACT_ERROR_OVERFLOW -7
#define STARY_CONTACT_ERROR_NUMERICAL -8
#define STARY_CONTACT_ERROR_REENTRANT -9

struct stary_contact_pair {
    int first_particle_index;
    int second_particle_index;
};

struct stary_contact_state {
    int pending;
    double time;
    struct stary_contact_pair* pairs;
    size_t pair_count;
    struct stary_contact_pair* suppressed_pairs;
    size_t suppressed_pair_count;
    size_t temporary_copy_count;
};

void stary_contact_state_init(struct stary_contact_state* state);
void stary_contact_state_acknowledge(struct stary_contact_state* state);
void stary_contact_state_discard(struct stary_contact_state* state);
void stary_contact_state_clear(struct stary_contact_state* state);
void stary_contact_state_destroy(struct stary_contact_state* state);

int stary_contact_advance(
    struct reb_simulation** simulation,
    struct stary_contact_state* state,
    double target_time
);

#endif
