#!/usr/bin/env bash
set -euo pipefail

commit="cabb68a03ebb4f3f1c71c6ff8cde33a1476ac417"
source_dir=".cache/rebound-${commit}"

test "$(tr -d '\r\n' < "${source_dir}/version.txt")" = "5.0.1"
patch --forward --batch --fuzz=0 --directory="${source_dir}" -p1 \
  < patches/rebound-5.0.1-worker-no-emscripten-sleep.patch
mkdir -p dist

emcc \
  -O3 \
  -std=c11 \
  -Wall \
  -Wextra \
  -Werror \
  -DNDEBUG \
  -D_GNU_SOURCE \
  -DGITHASH=${commit} \
  -fno-fast-math \
  -I"${source_dir}/src" \
  "${source_dir}"/src/*.c \
  src/rebound_bridge.c \
  src/rebound_contact.c \
  --no-entry \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createReboundModule \
  -sENVIRONMENT=worker,node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sFILESYSTEM=0 \
  -sASSERTIONS=0 \
  -sERROR_ON_UNDEFINED_SYMBOLS=1 \
  -sEXPORTED_FUNCTIONS='["_stary_reb_create","_stary_reb_destroy","_stary_reb_reset","_stary_reb_add_particle","_stary_reb_set_integrator","_stary_reb_move_to_com","_stary_reb_integrate","_stary_reb_advance_until_event","_stary_reb_contact_count","_stary_reb_contact_time","_stary_reb_contact_particle_index","_stary_reb_clear_contact","_stary_reb_discard_contact","_stary_reb_temporary_copy_count","_stary_reb_particle_count","_stary_reb_get_time","_stary_reb_get_particle_value","_stary_reb_energy","_stary_reb_angular_momentum_value"]' \
  -o dist/rebound.mjs
