#pragma once
// Compatibility shim. The DBW observation state model moved to
// "ghostwheel/dbw_observer_state.hpp" and was renamed DbwObservation so the
// same decision logic serves both the PACMod3 and Dataspeed DBW adapters.
#include "ghostwheel/dbw_observer_state.hpp"

namespace ghostwheel {
using PacmodObservation = DbwObservation;
}  // namespace ghostwheel
