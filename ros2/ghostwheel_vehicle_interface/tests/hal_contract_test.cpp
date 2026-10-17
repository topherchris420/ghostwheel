#include "ghostwheel/hal.hpp"

#include <cassert>
#include <cmath>
#include <string>

int main() {
  std::string reason;
  auto sim = ghostwheel::make_sim_interface();
  assert(sim->is_simulation());
  assert(sim->connect(reason));
  assert(sim->send_command(0.5, 0.0, 0.25));
  const auto status = sim->read_status();
  assert(status.valid);
  assert(std::fabs(status.accel_report - 0.5) < 1e-9);
  assert(std::fabs(status.steer_report - 0.25) < 1e-9);
  assert(sim->send_command(0.0, 1.0, 0.0));
  sim->disconnect();

  auto can = ghostwheel::make_can_monitor("can0");
  assert(!can->is_simulation());
  assert(!can->send_command(1.0, 0.0, 1.0));
  assert(!can->read_status().valid);
  auto serial = ghostwheel::make_serial_monitor("/dev/ttyUSB0", 115200, false);
  assert(!serial->send_command(1.0, 0.0, 1.0));
  assert(!serial->read_status().valid);
  auto obd = ghostwheel::make_serial_monitor("/dev/ttyUSB0", 38400, true);
  assert(!obd->send_command(0.0, 1.0, -1.0));
  assert(!obd->read_status().valid);
  return 0;
}
