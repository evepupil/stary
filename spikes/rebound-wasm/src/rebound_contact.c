#include "rebound_contact.h"

#include <float.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "simulation.h"

#define STARY_MAX_CONTACT_PAIRS 4096
#define STARY_MAX_REFINEMENT_DEPTH 64
#define STARY_MAX_REPLAY_COUNT 200000
#define STARY_MAX_REFINEMENT_NODES 200000
#define STARY_MIN_TIME_TOLERANCE_SECONDS 1e-9
#define STARY_CONTACT_INTERVAL_CLEAR 2

struct stary_contact_context {
    struct reb_simulation* main_simulation;
    struct reb_simulation* checkpoint;
    struct stary_contact_state* state;
    double step_interval_seconds;
    double event_time;
    struct stary_contact_pair* candidate_pairs;
    size_t candidate_pair_count;
    size_t refinement_nodes;
    size_t replay_count;
    size_t filter_first_index;
    size_t filter_second_index;
    int filter_enabled;
    int event_found;
    int error;
};

struct stary_pair_sample {
    double distance;
    double radial_speed;
};

static struct stary_contact_context* stary_active_contact_context = NULL;

static int stary_pair_is_in_scope(
    const struct stary_contact_context* context,
    size_t first_index,
    size_t second_index
) {
    return !context->filter_enabled ||
        (context->filter_first_index == first_index &&
         context->filter_second_index == second_index);
}

static double stary_max(double left, double right) {
    return left > right ? left : right;
}

static double stary_vector_norm(double x, double y, double z) {
    return hypot(hypot(x, y), z);
}

static double stary_ulp(double value) {
    const double magnitude = fabs(value);
    const double next = nextafter(magnitude, INFINITY);
    const double ulp = next - magnitude;
    return isfinite(ulp) && ulp > 0.0 ? ulp : DBL_TRUE_MIN;
}

static void stary_release_copy(
    struct stary_contact_context* context,
    struct reb_simulation* simulation
) {
    if (simulation == NULL) {
        return;
    }
    reb_simulation_free(simulation);
    if (context->state->temporary_copy_count > 0) {
        context->state->temporary_copy_count--;
    }
}

static void stary_adopt_copy(struct stary_contact_context* context) {
    if (context->state->temporary_copy_count > 0) {
        context->state->temporary_copy_count--;
    }
}

static struct reb_simulation* stary_create_copy(
    struct stary_contact_context* context,
    struct reb_simulation* source
) {
    void (*heartbeat)(struct reb_simulation*) = source->heartbeat;
    source->heartbeat = NULL;
    struct reb_simulation* copy = reb_simulation_create();
    enum REB_BINARYDATA_ERROR_CODE warnings = REB_BINARYDATA_WARNING_NONE;
    if (copy != NULL) {
        reb_simulation_copy_with_messages(copy, source, &warnings);
        if (warnings != REB_BINARYDATA_WARNING_NONE) {
            reb_simulation_free(copy);
            copy = NULL;
        }
    }
    source->heartbeat = heartbeat;
    if (copy != NULL) {
        copy->heartbeat = NULL;
        context->state->temporary_copy_count++;
    }
    return copy;
}

static int stary_integrated_copy(
    struct stary_contact_context* context,
    struct reb_simulation* source,
    double target_time,
    struct reb_simulation** output
) {
    if (context->replay_count >= STARY_MAX_REPLAY_COUNT) {
        return STARY_CONTACT_ERROR_NUMERICAL;
    }
    context->replay_count++;
    struct reb_simulation* copy = stary_create_copy(context, source);
    if (copy == NULL) {
        return STARY_CONTACT_ERROR_ALLOCATION;
    }
    if (target_time > copy->t) {
        const enum REB_STATUS status = reb_simulation_integrate(copy, target_time);
        if (status != REB_STATUS_SUCCESS) {
            stary_release_copy(context, copy);
            return STARY_CONTACT_ERROR_INTEGRATION;
        }
    }
    *output = copy;
    return STARY_CONTACT_ADVANCED;
}

static double stary_world_coordinate_scale(
    const struct reb_simulation* start,
    const struct reb_simulation* end,
    size_t first_index,
    size_t second_index
) {
    const struct reb_particle* particles[] = {
        &start->particles[first_index],
        &start->particles[second_index],
        &end->particles[first_index],
        &end->particles[second_index],
    };
    double scale = 1.0;
    for (size_t index = 0; index < sizeof(particles) / sizeof(particles[0]); index++) {
        const struct reb_particle* particle = particles[index];
        scale = stary_max(scale, fabs(particle->x));
        scale = stary_max(scale, fabs(particle->y));
        scale = stary_max(scale, fabs(particle->z));
        scale = stary_max(scale, particle->r);
    }
    return scale;
}

static double stary_distance_tolerance(
    const struct reb_simulation* start,
    const struct reb_simulation* end,
    size_t first_index,
    size_t second_index
) {
    const double radius_sum =
        start->particles[first_index].r + start->particles[second_index].r;
    const double scale = stary_world_coordinate_scale(start, end, first_index, second_index);
    const double radius_tolerance = 1e-10 * radius_sum;
    const double coordinate_tolerance = 64.0 * stary_ulp(scale);
    const double integrator_budget = 256.0 * DBL_EPSILON * scale;
    return stary_max(radius_tolerance, stary_max(coordinate_tolerance, integrator_budget));
}

static struct stary_pair_sample stary_sample_pair(
    const struct reb_simulation* simulation,
    size_t first_index,
    size_t second_index
) {
    const struct reb_particle* first = &simulation->particles[first_index];
    const struct reb_particle* second = &simulation->particles[second_index];
    const double dx = second->x - first->x;
    const double dy = second->y - first->y;
    const double dz = second->z - first->z;
    const double dvx = second->vx - first->vx;
    const double dvy = second->vy - first->vy;
    const double dvz = second->vz - first->vz;
    const double distance = stary_vector_norm(dx, dy, dz);
    const double radial_speed = distance > 0.0
        ? (dx * dvx + dy * dvy + dz * dvz) / distance
        : 0.0;
    const struct stary_pair_sample sample = {
        .distance = distance,
        .radial_speed = radial_speed,
    };
    return sample;
}

static double stary_relative_speed(
    const struct reb_simulation* simulation,
    size_t first_index,
    size_t second_index
) {
    const struct reb_particle* first = &simulation->particles[first_index];
    const struct reb_particle* second = &simulation->particles[second_index];
    return stary_vector_norm(
        second->vx - first->vx,
        second->vy - first->vy,
        second->vz - first->vz
    );
}

static double stary_time_tolerance(
    const struct stary_contact_context* context,
    const struct reb_simulation* start,
    const struct reb_simulation* end,
    size_t first_index,
    size_t second_index,
    double distance_tolerance
) {
    const double interval = end->t - start->t;
    const double time_scale = stary_max(fabs(start->t), fabs(end->t));
    const double base_tolerance = stary_max(
        STARY_MIN_TIME_TOLERANCE_SECONDS,
        stary_max(8.0 * stary_ulp(time_scale), 1e-12 * context->step_interval_seconds)
    );
    const double relative_speed = stary_max(
        stary_relative_speed(start, first_index, second_index),
        stary_relative_speed(end, first_index, second_index)
    );
    const double denominator = stary_max(
        relative_speed,
        distance_tolerance / stary_max(interval, STARY_MIN_TIME_TOLERANCE_SECONDS)
    );
    return stary_max(base_tolerance, distance_tolerance / denominator);
}

static int stary_pair_is_contact(
    const struct reb_simulation* simulation,
    size_t first_index,
    size_t second_index,
    double distance_tolerance
) {
    const struct reb_particle* first = &simulation->particles[first_index];
    const struct reb_particle* second = &simulation->particles[second_index];
    const double radius_sum = first->r + second->r;
    if (radius_sum <= 0.0) {
        return 0;
    }
    const struct stary_pair_sample sample = stary_sample_pair(
        simulation,
        first_index,
        second_index
    );
    const double velocity_tolerance = 128.0 * DBL_EPSILON *
        stary_max(stary_relative_speed(simulation, first_index, second_index), 1.0);
    return sample.distance <= radius_sum + distance_tolerance &&
        sample.radial_speed <= velocity_tolerance;
}

static int stary_pair_is_suppressed(
    const struct stary_contact_state* state,
    const struct reb_simulation* simulation,
    size_t first_index,
    size_t second_index,
    double distance_tolerance
) {
    int listed = 0;
    for (size_t index = 0; index < state->suppressed_pair_count; index++) {
        const struct stary_contact_pair pair = state->suppressed_pairs[index];
        if (pair.first_particle_index == (int)first_index &&
            pair.second_particle_index == (int)second_index) {
            listed = 1;
            break;
        }
    }
    if (!listed) {
        return 0;
    }
    const struct stary_pair_sample sample = stary_sample_pair(
        simulation,
        first_index,
        second_index
    );
    const double radius_sum =
        simulation->particles[first_index].r + simulation->particles[second_index].r;
    const double velocity_tolerance = 8.0 * sqrt(DBL_EPSILON) *
        stary_max(stary_relative_speed(simulation, first_index, second_index), 1.0);
    return sample.distance <= radius_sum + distance_tolerance &&
        sample.radial_speed >= -velocity_tolerance;
}

static int stary_state_has_contact(
    const struct stary_contact_context* context,
    const struct reb_simulation* simulation,
    int include_distance_tolerance
) {
    for (size_t first_index = 0; first_index < simulation->N; first_index++) {
        for (size_t second_index = first_index + 1; second_index < simulation->N; second_index++) {
            if (!stary_pair_is_in_scope(context, first_index, second_index)) {
                continue;
            }
            const double scale_tolerance = stary_distance_tolerance(
                simulation,
                simulation,
                first_index,
                second_index
            );
            const double radius_sum =
                simulation->particles[first_index].r + simulation->particles[second_index].r;
            const double tolerance = include_distance_tolerance
                ? scale_tolerance
                : -8.0 * stary_ulp(radius_sum);
            if (stary_pair_is_contact(
                simulation,
                first_index,
                second_index,
                tolerance
            ) && !stary_pair_is_suppressed(
                context->state,
                simulation,
                first_index,
                second_index,
                scale_tolerance
            )) {
                return 1;
            }
        }
    }
    return 0;
}

static double stary_chord_minimum_distance(
    const struct reb_simulation* start,
    const struct reb_simulation* end,
    size_t first_index,
    size_t second_index
) {
    const struct reb_particle* start_first = &start->particles[first_index];
    const struct reb_particle* start_second = &start->particles[second_index];
    const struct reb_particle* end_first = &end->particles[first_index];
    const struct reb_particle* end_second = &end->particles[second_index];
    const double x0 = start_second->x - start_first->x;
    const double y0 = start_second->y - start_first->y;
    const double z0 = start_second->z - start_first->z;
    const double dx = (end_second->x - end_first->x) - x0;
    const double dy = (end_second->y - end_first->y) - y0;
    const double dz = (end_second->z - end_first->z) - z0;
    const double chord_length_squared = dx * dx + dy * dy + dz * dz;
    double fraction = 0.0;
    if (chord_length_squared > 0.0) {
        fraction = -(x0 * dx + y0 * dy + z0 * dz) / chord_length_squared;
        if (fraction < 0.0) {
            fraction = 0.0;
        } else if (fraction > 1.0) {
            fraction = 1.0;
        }
    }
    return stary_vector_norm(
        x0 + fraction * dx,
        y0 + fraction * dy,
        z0 + fraction * dz
    );
}

static int stary_build_interval_acceleration_bounds(
    const struct reb_simulation* start,
    const struct reb_simulation* end,
    double* acceleration_bounds
) {
    const double interval = end->t - start->t;
    for (size_t first_index = 0; first_index < start->N; first_index++) {
        double bound = 0.0;
        for (size_t second_index = 0; second_index < start->N; second_index++) {
            if (first_index == second_index) {
                continue;
            }
            const struct stary_pair_sample sample = stary_sample_pair(
                start,
                first_index,
                second_index
            );
            const double minimum_distance = sample.distance * 0.5;
            if (minimum_distance <= 0.0) {
                return 0;
            }
            bound += start->G * start->particles[second_index].m /
                (minimum_distance * minimum_distance);
            if (!isfinite(bound)) {
                return 0;
            }
        }
        acceleration_bounds[first_index] = bound;
    }

    for (size_t first_index = 0; first_index < start->N; first_index++) {
        for (size_t second_index = first_index + 1; second_index < start->N; second_index++) {
            const struct stary_pair_sample sample = stary_sample_pair(
                start,
                first_index,
                second_index
            );
            const double acceleration_bound =
                acceleration_bounds[first_index] + acceleration_bounds[second_index];
            const double displacement_bound =
                stary_relative_speed(start, first_index, second_index) * interval +
                0.5 * acceleration_bound * interval * interval;
            if (!isfinite(displacement_bound) || displacement_bound > sample.distance * 0.5) {
                return 0;
            }
        }
    }
    return 1;
}

static int stary_pair_is_monotonic_clear(
    const struct reb_simulation* start,
    const struct reb_simulation* end,
    size_t first_index,
    size_t second_index,
    double radius_sum,
    double acceleration_bound,
    int allow_contact_at_start
) {
    const double interval = end->t - start->t;
    const struct stary_pair_sample start_sample = stary_sample_pair(
        start,
        first_index,
        second_index
    );
    const struct stary_pair_sample end_sample = stary_sample_pair(
        end,
        first_index,
        second_index
    );
    const double minimum_distance = start_sample.distance * 0.5;
    if (minimum_distance <= 0.0) {
        return 0;
    }
    const double speed_bound =
        stary_relative_speed(start, first_index, second_index) + acceleration_bound * interval;
    const double radial_derivative_bound =
        acceleration_bound + speed_bound * speed_bound / minimum_distance;
    const double radial_variation_bound = radial_derivative_bound * interval;
    const double surface_tolerance = 8.0 * stary_ulp(radius_sum);
    if (start_sample.radial_speed + radial_variation_bound < 0.0 &&
        end_sample.distance > radius_sum + surface_tolerance) {
        return 1;
    }
    return end_sample.radial_speed - radial_variation_bound > 0.0 &&
        (allow_contact_at_start || start_sample.distance > radius_sum + surface_tolerance);
}

static int stary_interval_is_proven_safe(
    const struct stary_contact_context* context,
    const struct reb_simulation* start,
    const struct reb_simulation* end,
    const double* acceleration_bounds,
    int enclosure_valid
) {
    const double interval = end->t - start->t;
    for (size_t first_index = 0; first_index < start->N; first_index++) {
        for (size_t second_index = first_index + 1; second_index < start->N; second_index++) {
            if (!stary_pair_is_in_scope(context, first_index, second_index)) {
                continue;
            }
            const double radius_sum =
                start->particles[first_index].r + start->particles[second_index].r;
            if (radius_sum <= 0.0) {
                continue;
            }
            const double tolerance = stary_distance_tolerance(
                start,
                end,
                first_index,
                second_index
            );
            const struct stary_pair_sample start_sample = stary_sample_pair(
                start,
                first_index,
                second_index
            );
            const double velocity_tolerance = 128.0 * DBL_EPSILON *
                stary_max(stary_relative_speed(start, first_index, second_index), 1.0);
            const int separating_overlap =
                start_sample.distance <= radius_sum + tolerance &&
                start_sample.radial_speed > velocity_tolerance;
            const int suppressed = stary_pair_is_suppressed(
                context->state,
                start,
                first_index,
                second_index,
                tolerance
            );
            if (!enclosure_valid) {
                return 0;
            }
            const double acceleration_bound =
                acceleration_bounds[first_index] + acceleration_bounds[second_index];
            const double curve_bound = acceleration_bound * interval * interval / 8.0;
            const double chord_distance = stary_chord_minimum_distance(
                start,
                end,
                first_index,
                second_index
            );
            if (stary_pair_is_monotonic_clear(
                start,
                end,
                first_index,
                second_index,
                radius_sum,
                acceleration_bound,
                separating_overlap || suppressed
            )) {
                continue;
            }
            if (suppressed &&
                chord_distance - curve_bound >= radius_sum - 8.0 * stary_ulp(radius_sum)) {
                continue;
            }
            if (chord_distance <= radius_sum + tolerance + curve_bound) {
                return 0;
            }
        }
    }
    return 1;
}

static int stary_pair_may_contact(
    const struct stary_contact_context* context,
    const struct reb_simulation* start,
    const struct reb_simulation* end,
    size_t first_index,
    size_t second_index,
    const double* acceleration_bounds,
    int enclosure_valid
) {
    const double radius_sum =
        start->particles[first_index].r + start->particles[second_index].r;
    if (radius_sum <= 0.0) {
        return 0;
    }
    const double tolerance = stary_distance_tolerance(
        start,
        end,
        first_index,
        second_index
    );
    const struct stary_pair_sample start_sample = stary_sample_pair(
        start,
        first_index,
        second_index
    );
    const double velocity_tolerance = 128.0 * DBL_EPSILON *
        stary_max(stary_relative_speed(start, first_index, second_index), 1.0);
    const int separating_overlap =
        start_sample.distance <= radius_sum + tolerance &&
        start_sample.radial_speed > velocity_tolerance;
    const int suppressed = stary_pair_is_suppressed(
        context->state,
        start,
        first_index,
        second_index,
        tolerance
    );
    if (!enclosure_valid) {
        return 1;
    }
    const double interval = end->t - start->t;
    const double acceleration_bound =
        acceleration_bounds[first_index] + acceleration_bounds[second_index];
    if (stary_pair_is_monotonic_clear(
        start,
        end,
        first_index,
        second_index,
        radius_sum,
        acceleration_bound,
        separating_overlap || suppressed
    )) {
        return 0;
    }
    const double chord_distance = stary_chord_minimum_distance(
        start,
        end,
        first_index,
        second_index
    );
    const double curve_bound = acceleration_bound * interval * interval / 8.0;
    if (suppressed &&
        chord_distance - curve_bound >= radius_sum - 8.0 * stary_ulp(radius_sum)) {
        return 0;
    }
    return chord_distance <= radius_sum + tolerance + curve_bound;
}

static int stary_minimize_pair_distance(
    struct stary_contact_context* context,
    struct reb_simulation* origin,
    struct reb_simulation* start,
    struct reb_simulation* end,
    size_t first_index,
    size_t second_index,
    double* event_time
) {
    const double tolerance = stary_distance_tolerance(
        start,
        end,
        first_index,
        second_index
    );
    const double time_tolerance = stary_time_tolerance(
        context,
        start,
        end,
        first_index,
        second_index,
        tolerance
    );
    double left = start->t;
    double right = end->t;
    double best_time = start->t;
    struct stary_pair_sample best = stary_sample_pair(start, first_index, second_index);
    const struct stary_pair_sample end_sample = stary_sample_pair(end, first_index, second_index);
    if (end_sample.distance < best.distance) {
        best = end_sample;
        best_time = end->t;
    }

    const struct stary_pair_sample initial_start_sample = stary_sample_pair(
        start,
        first_index,
        second_index
    );
    if (initial_start_sample.radial_speed <= 0.0 && end_sample.radial_speed >= 0.0) {
        for (int iteration = 0; iteration < 64 && right - left > time_tolerance; iteration++) {
            const double midpoint_time = left + (right - left) * 0.5;
            struct reb_simulation* midpoint = NULL;
            const int status = stary_integrated_copy(
                context,
                origin,
                midpoint_time,
                &midpoint
            );
            if (status != STARY_CONTACT_ADVANCED) {
                return status;
            }
            const struct stary_pair_sample midpoint_sample = stary_sample_pair(
                midpoint,
                first_index,
                second_index
            );
            if (midpoint_sample.radial_speed < 0.0) {
                left = midpoint_time;
            } else {
                right = midpoint_time;
                best = midpoint_sample;
                best_time = midpoint_time;
            }
            stary_release_copy(context, midpoint);
        }
    } else {
        for (int iteration = 0;
             iteration < 80 && right - left > time_tolerance * 0.25;
             iteration++) {
            const double first_time = left + (right - left) / 3.0;
            const double second_time = right - (right - left) / 3.0;
            struct reb_simulation* first_simulation = NULL;
            struct reb_simulation* second_simulation = NULL;
            int status = stary_integrated_copy(context, origin, first_time, &first_simulation);
            if (status != STARY_CONTACT_ADVANCED) {
                return status;
            }
            status = stary_integrated_copy(context, origin, second_time, &second_simulation);
            if (status != STARY_CONTACT_ADVANCED) {
                stary_release_copy(context, first_simulation);
                return status;
            }
            const struct stary_pair_sample first_sample = stary_sample_pair(
                first_simulation,
                first_index,
                second_index
            );
            const struct stary_pair_sample second_sample = stary_sample_pair(
                second_simulation,
                first_index,
                second_index
            );
            if (first_sample.distance < best.distance) {
                best = first_sample;
                best_time = first_time;
            }
            if (second_sample.distance < best.distance) {
                best = second_sample;
                best_time = second_time;
            }
            if (first_sample.distance <= second_sample.distance) {
                right = second_time;
            } else {
                left = first_time;
            }
            stary_release_copy(context, first_simulation);
            stary_release_copy(context, second_simulation);
        }
    }

    const double radius_sum =
        start->particles[first_index].r + start->particles[second_index].r;
    const double velocity_tolerance = 128.0 * DBL_EPSILON * stary_max(
        stary_max(
            stary_relative_speed(start, first_index, second_index),
            stary_relative_speed(end, first_index, second_index)
        ),
        1.0
    );
    const struct stary_pair_sample start_sample = stary_sample_pair(
        start,
        first_index,
        second_index
    );
    if (best.distance <= radius_sum + tolerance) {
        double left_time = start->t;
        double right_time = best_time;
        const double tangent_classification_tolerance = 8.0 * stary_ulp(radius_sum);
        if (start_sample.distance < radius_sum - tangent_classification_tolerance) {
            *event_time = start->t;
            return STARY_CONTACT_FOUND;
        }
        if (best.distance >= radius_sum - tangent_classification_tolerance) {
            if (start_sample.radial_speed > velocity_tolerance ||
                end_sample.radial_speed < -velocity_tolerance) {
                return STARY_CONTACT_INTERVAL_CLEAR;
            }
            *event_time = best_time;
            return STARY_CONTACT_FOUND;
        }
        for (int iteration = 0;
             iteration < 64 && right_time - left_time > time_tolerance;
             iteration++) {
            const double midpoint_time = left_time + (right_time - left_time) * 0.5;
            struct reb_simulation* midpoint = NULL;
            const int status = stary_integrated_copy(
                context,
                origin,
                midpoint_time,
                &midpoint
            );
            if (status != STARY_CONTACT_ADVANCED) {
                return status;
            }
            const struct stary_pair_sample midpoint_sample = stary_sample_pair(
                midpoint,
                first_index,
                second_index
            );
            if (midpoint_sample.distance <= radius_sum) {
                right_time = midpoint_time;
            } else {
                left_time = midpoint_time;
            }
            stary_release_copy(context, midpoint);
        }
        *event_time = right_time;
        return STARY_CONTACT_FOUND;
    }
    if ((start_sample.radial_speed < -velocity_tolerance &&
         end_sample.radial_speed < -velocity_tolerance) ||
        (start_sample.radial_speed > velocity_tolerance &&
         end_sample.radial_speed > velocity_tolerance)) {
        return STARY_CONTACT_INTERVAL_CLEAR;
    }
    return best.distance > radius_sum + tolerance
        ? STARY_CONTACT_INTERVAL_CLEAR
        : STARY_CONTACT_ERROR_NUMERICAL;
}

static int stary_leaf_event(
    struct stary_contact_context* context,
    struct reb_simulation* origin,
    struct reb_simulation* start,
    struct reb_simulation* end,
    const double* acceleration_bounds,
    int enclosure_valid,
    double* event_time
) {
    int found = 0;
    double earliest = end->t;
    for (size_t first_index = 0; first_index < start->N; first_index++) {
        for (size_t second_index = first_index + 1; second_index < start->N; second_index++) {
            if (!stary_pair_is_in_scope(context, first_index, second_index)) {
                continue;
            }
            if (!stary_pair_may_contact(
                context,
                start,
                end,
                first_index,
                second_index,
                acceleration_bounds,
                enclosure_valid
            )) {
                continue;
            }
            double pair_time = 0.0;
            const int status = stary_minimize_pair_distance(
                context,
                origin,
                start,
                end,
                first_index,
                second_index,
                &pair_time
            );
            if (status < 0) {
                return status;
            }
            if (status == STARY_CONTACT_INTERVAL_CLEAR) {
                continue;
            }
            if (status == STARY_CONTACT_FOUND && (!found || pair_time < earliest)) {
                found = 1;
                earliest = pair_time;
            }
        }
    }
    if (found) {
        *event_time = earliest;
        return STARY_CONTACT_FOUND;
    }
    return STARY_CONTACT_ADVANCED;
}

static double stary_interval_time_tolerance(
    const struct stary_contact_context* context,
    const struct reb_simulation* start,
    const struct reb_simulation* end,
    const double* acceleration_bounds,
    int enclosure_valid
) {
    double tolerance = STARY_MIN_TIME_TOLERANCE_SECONDS;
    int found_pair = 0;
    for (size_t first_index = 0; first_index < start->N; first_index++) {
        for (size_t second_index = first_index + 1; second_index < start->N; second_index++) {
            if (!stary_pair_is_in_scope(context, first_index, second_index)) {
                continue;
            }
            if (!stary_pair_may_contact(
                context,
                start,
                end,
                first_index,
                second_index,
                acceleration_bounds,
                enclosure_valid
            )) {
                continue;
            }
            const double distance_tolerance = stary_distance_tolerance(
                start,
                end,
                first_index,
                second_index
            );
            const double pair_tolerance = stary_time_tolerance(
                context,
                start,
                end,
                first_index,
                second_index,
                distance_tolerance
            );
            if (!found_pair || pair_tolerance < tolerance) {
                tolerance = pair_tolerance;
                found_pair = 1;
            }
        }
    }
    return tolerance;
}

static int stary_find_event_in_interval(
    struct stary_contact_context* context,
    struct reb_simulation* origin,
    struct reb_simulation* start,
    struct reb_simulation* end,
    int depth,
    double* event_time
) {
    if (context->refinement_nodes >= STARY_MAX_REFINEMENT_NODES) {
        return STARY_CONTACT_ERROR_NUMERICAL;
    }
    context->refinement_nodes++;
    const double interval = end->t - start->t;
    if (stary_state_has_contact(context, start, 0)) {
        *event_time = start->t;
        return STARY_CONTACT_FOUND;
    }
    double* acceleration_bounds = calloc(start->N, sizeof(*acceleration_bounds));
    if (acceleration_bounds == NULL && start->N > 0) {
        return STARY_CONTACT_ERROR_ALLOCATION;
    }
    const int enclosure_valid = stary_build_interval_acceleration_bounds(
        start,
        end,
        acceleration_bounds
    );
    if (stary_interval_is_proven_safe(
        context,
        start,
        end,
        acceleration_bounds,
        enclosure_valid
    )) {
        free(acceleration_bounds);
        return STARY_CONTACT_ADVANCED;
    }
    const double interval_time_tolerance = stary_interval_time_tolerance(
        context,
        start,
        end,
        acceleration_bounds,
        enclosure_valid
    );
    if (depth >= STARY_MAX_REFINEMENT_DEPTH && interval > interval_time_tolerance) {
        free(acceleration_bounds);
        return STARY_CONTACT_ERROR_NUMERICAL;
    }
    if (interval <= interval_time_tolerance || depth >= STARY_MAX_REFINEMENT_DEPTH) {
        const int status = stary_leaf_event(
            context,
            origin,
            start,
            end,
            acceleration_bounds,
            enclosure_valid,
            event_time
        );
        free(acceleration_bounds);
        return status;
    }

    const double midpoint_time = start->t + interval * 0.5;
    if (!(midpoint_time > start->t && midpoint_time < end->t)) {
        const int status = stary_leaf_event(
            context,
            origin,
            start,
            end,
            acceleration_bounds,
            enclosure_valid,
            event_time
        );
        free(acceleration_bounds);
        return status;
    }
    free(acceleration_bounds);
    struct reb_simulation* midpoint = NULL;
    const int midpoint_status = stary_integrated_copy(
        context,
        origin,
        midpoint_time,
        &midpoint
    );
    if (midpoint_status != STARY_CONTACT_ADVANCED) {
        return midpoint_status;
    }

    int status = stary_find_event_in_interval(
        context,
        origin,
        start,
        midpoint,
        depth + 1,
        event_time
    );
    if (status == STARY_CONTACT_ADVANCED) {
        status = stary_find_event_in_interval(
            context,
            origin,
            midpoint,
            end,
            depth + 1,
            event_time
        );
    }
    stary_release_copy(context, midpoint);
    return status;
}

static void stary_contact_heartbeat(struct reb_simulation* simulation) {
    struct stary_contact_context* context = stary_active_contact_context;
    if (context == NULL || context->main_simulation != simulation ||
        context->error != 0 || context->event_found) {
        reb_simulation_stop(simulation);
        return;
    }
    if (context->checkpoint == NULL) {
        context->checkpoint = stary_create_copy(context, simulation);
        if (context->checkpoint == NULL) {
            context->error = STARY_CONTACT_ERROR_ALLOCATION;
            reb_simulation_stop(simulation);
        }
        return;
    }

    double event_time = 0.0;
    context->step_interval_seconds = simulation->t - context->checkpoint->t;
    const int status = stary_find_event_in_interval(
        context,
        context->checkpoint,
        context->checkpoint,
        simulation,
        0,
        &event_time
    );
    if (status < 0) {
        context->error = status;
        reb_simulation_stop(simulation);
        return;
    }
    if (status == STARY_CONTACT_FOUND) {
        context->event_found = 1;
        context->event_time = event_time;
        reb_simulation_stop(simulation);
        return;
    }

    stary_release_copy(context, context->checkpoint);
    context->checkpoint = stary_create_copy(context, simulation);
    if (context->checkpoint == NULL) {
        context->error = STARY_CONTACT_ERROR_ALLOCATION;
        reb_simulation_stop(simulation);
    }
}

static void stary_rollback_to_checkpoint(
    struct stary_contact_context* context,
    struct reb_simulation** simulation
) {
    if (context->checkpoint == NULL) {
        return;
    }
    reb_simulation_free(*simulation);
    *simulation = context->checkpoint;
    context->checkpoint = NULL;
    stary_adopt_copy(context);
}

static int stary_candidate_contains(
    const struct stary_contact_context* context,
    size_t first_index,
    size_t second_index
) {
    for (size_t index = 0; index < context->candidate_pair_count; index++) {
        const struct stary_contact_pair pair = context->candidate_pairs[index];
        if (pair.first_particle_index == (int)first_index &&
            pair.second_particle_index == (int)second_index) {
            return 1;
        }
    }
    return 0;
}

static int stary_collect_time_candidates(
    struct stary_contact_context* context,
    struct reb_simulation* step_end
) {
    context->candidate_pairs = calloc(
        STARY_MAX_CONTACT_PAIRS,
        sizeof(*context->candidate_pairs)
    );
    if (context->candidate_pairs == NULL) {
        return STARY_CONTACT_ERROR_ALLOCATION;
    }

    for (size_t first_index = 0; first_index < context->checkpoint->N; first_index++) {
        for (size_t second_index = first_index + 1;
             second_index < context->checkpoint->N;
             second_index++) {
            context->filter_enabled = 1;
            context->filter_first_index = first_index;
            context->filter_second_index = second_index;
            double pair_time = NAN;
            const int status = stary_find_event_in_interval(
                context,
                context->checkpoint,
                context->checkpoint,
                step_end,
                0,
                &pair_time
            );
            if (status < 0) {
                context->filter_enabled = 0;
                return status;
            }
            if (status != STARY_CONTACT_FOUND) {
                continue;
            }
            const double distance_tolerance = stary_distance_tolerance(
                context->checkpoint,
                step_end,
                first_index,
                second_index
            );
            const double time_tolerance = stary_time_tolerance(
                context,
                context->checkpoint,
                step_end,
                first_index,
                second_index,
                distance_tolerance
            );
            if (fabs(pair_time - context->event_time) > time_tolerance) {
                continue;
            }
            if (context->candidate_pair_count >= STARY_MAX_CONTACT_PAIRS) {
                context->filter_enabled = 0;
                return STARY_CONTACT_ERROR_OVERFLOW;
            }
            context->candidate_pairs[context->candidate_pair_count].first_particle_index =
                (int)first_index;
            context->candidate_pairs[context->candidate_pair_count].second_particle_index =
                (int)second_index;
            context->candidate_pair_count++;
        }
    }
    context->filter_enabled = 0;
    return context->candidate_pair_count > 0
        ? STARY_CONTACT_ADVANCED
        : STARY_CONTACT_ERROR_NUMERICAL;
}

static int stary_collect_contact_pairs(
    struct stary_contact_context* context,
    const struct reb_simulation* simulation
) {
    size_t pair_count = 0;
    for (size_t first_index = 0; first_index < simulation->N; first_index++) {
        for (size_t second_index = first_index + 1; second_index < simulation->N; second_index++) {
            const double tolerance = stary_distance_tolerance(
                simulation,
                simulation,
                first_index,
                second_index
            );
            const int time_candidate = stary_candidate_contains(
                context,
                first_index,
                second_index
            );
            const int snapshot_supplement = stary_pair_is_contact(
                simulation,
                first_index,
                second_index,
                tolerance
            ) && !stary_pair_is_suppressed(
                context->state,
                simulation,
                first_index,
                second_index,
                tolerance
            );
            if (time_candidate || snapshot_supplement) {
                pair_count++;
                if (pair_count > STARY_MAX_CONTACT_PAIRS) {
                    return STARY_CONTACT_ERROR_OVERFLOW;
                }
            }
        }
    }
    if (pair_count == 0) {
        return STARY_CONTACT_ERROR_NUMERICAL;
    }

    struct stary_contact_pair* pairs = calloc(pair_count, sizeof(*pairs));
    if (pairs == NULL) {
        return STARY_CONTACT_ERROR_ALLOCATION;
    }
    size_t output_index = 0;
    for (size_t first_index = 0; first_index < simulation->N; first_index++) {
        for (size_t second_index = first_index + 1; second_index < simulation->N; second_index++) {
            const double tolerance = stary_distance_tolerance(
                simulation,
                simulation,
                first_index,
                second_index
            );
            const int time_candidate = stary_candidate_contains(
                context,
                first_index,
                second_index
            );
            const int snapshot_supplement = stary_pair_is_contact(
                simulation,
                first_index,
                second_index,
                tolerance
            ) && !stary_pair_is_suppressed(
                context->state,
                simulation,
                first_index,
                second_index,
                tolerance
            );
            if (!time_candidate && !snapshot_supplement) {
                continue;
            }
            pairs[output_index].first_particle_index = (int)first_index;
            pairs[output_index].second_particle_index = (int)second_index;
            output_index++;
        }
    }
    context->state->pairs = pairs;
    context->state->pair_count = pair_count;
    context->state->time = simulation->t;
    context->state->pending = 1;
    return STARY_CONTACT_FOUND;
}

void stary_contact_state_init(struct stary_contact_state* state) {
    state->pending = 0;
    state->time = NAN;
    state->pairs = NULL;
    state->pair_count = 0;
    state->suppressed_pairs = NULL;
    state->suppressed_pair_count = 0;
    state->temporary_copy_count = 0;
}

void stary_contact_state_acknowledge(struct stary_contact_state* state) {
    if (!state->pending) {
        return;
    }
    free(state->suppressed_pairs);
    state->suppressed_pairs = state->pairs;
    state->suppressed_pair_count = state->pair_count;
    state->pending = 0;
    state->time = NAN;
    state->pairs = NULL;
    state->pair_count = 0;
}

void stary_contact_state_discard(struct stary_contact_state* state) {
    free(state->pairs);
    state->pending = 0;
    state->time = NAN;
    state->pairs = NULL;
    state->pair_count = 0;
}

void stary_contact_state_clear(struct stary_contact_state* state) {
    free(state->pairs);
    free(state->suppressed_pairs);
    state->pending = 0;
    state->time = NAN;
    state->pairs = NULL;
    state->pair_count = 0;
    state->suppressed_pairs = NULL;
    state->suppressed_pair_count = 0;
}

void stary_contact_state_destroy(struct stary_contact_state* state) {
    stary_contact_state_clear(state);
}

int stary_contact_advance(
    struct reb_simulation** simulation,
    struct stary_contact_state* state,
    double target_time
) {
    if (!isfinite(target_time) || target_time < (*simulation)->t) {
        return STARY_CONTACT_ERROR_INVALID_TARGET;
    }
    if (state->pending) {
        return STARY_CONTACT_ERROR_PENDING;
    }
    if (strcmp((*simulation)->integrator.name, "ias15") != 0) {
        return STARY_CONTACT_ERROR_INTEGRATOR;
    }
    if (state->temporary_copy_count != 0 || stary_active_contact_context != NULL) {
        return STARY_CONTACT_ERROR_REENTRANT;
    }
    struct stary_contact_context context = {
        .main_simulation = *simulation,
        .checkpoint = NULL,
        .state = state,
        .step_interval_seconds = target_time - (*simulation)->t,
        .event_time = NAN,
        .candidate_pairs = NULL,
        .candidate_pair_count = 0,
        .refinement_nodes = 0,
        .replay_count = 0,
        .filter_first_index = 0,
        .filter_second_index = 0,
        .filter_enabled = 0,
        .event_found = 0,
        .error = 0,
    };
    if (target_time == (*simulation)->t) {
        return stary_state_has_contact(&context, *simulation, 1)
            ? stary_collect_contact_pairs(&context, *simulation)
            : STARY_CONTACT_ADVANCED;
    }
    int status = STARY_CONTACT_ADVANCED;

    void (*previous_heartbeat)(struct reb_simulation*) = (*simulation)->heartbeat;
    if (previous_heartbeat != NULL) {
        return STARY_CONTACT_ERROR_REENTRANT;
    }
    (*simulation)->heartbeat = stary_contact_heartbeat;
    stary_active_contact_context = &context;
    const enum REB_STATUS integration_status = reb_simulation_integrate(*simulation, target_time);
    stary_active_contact_context = NULL;
    (*simulation)->heartbeat = previous_heartbeat;

    if (context.error != 0) {
        status = context.error;
        stary_rollback_to_checkpoint(&context, simulation);
    } else if (context.event_found) {
        struct reb_simulation* contact_simulation = NULL;
        status = stary_collect_time_candidates(&context, *simulation);
        if (status == STARY_CONTACT_ADVANCED) {
            status = stary_integrated_copy(
                &context,
                context.checkpoint,
                context.event_time,
                &contact_simulation
            );
        }
        if (status == STARY_CONTACT_ADVANCED) {
            status = stary_collect_contact_pairs(&context, contact_simulation);
        }
        if (status == STARY_CONTACT_FOUND) {
            reb_simulation_free(*simulation);
            *simulation = contact_simulation;
            stary_adopt_copy(&context);
        } else {
            stary_release_copy(&context, contact_simulation);
            stary_rollback_to_checkpoint(&context, simulation);
        }
    } else if (integration_status != REB_STATUS_SUCCESS) {
        status = STARY_CONTACT_ERROR_INTEGRATION;
        stary_rollback_to_checkpoint(&context, simulation);
    } else {
        status = STARY_CONTACT_ADVANCED;
    }

    stary_release_copy(&context, context.checkpoint);
    free(context.candidate_pairs);
    if (state->temporary_copy_count != 0) {
        return STARY_CONTACT_ERROR_NUMERICAL;
    }
    return status;
}
