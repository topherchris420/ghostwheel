#include "ghostwheel/hal.hpp"

#include <cmath>
#include <string>

int main() {
  std::string reason;
  auto sim = ghostwheel::make_sim_interface();
  if (!sim->is_simulation() || !sim->connect(reason)) return 1;
  if (!sim->send_command(0.5, 0.0, 0.25)) return 2;
  const auto status = sim->read_status();
  if (!status.valid || std::fabs(status.accel_report - 0.5) > 1e-9 ||
      std::fabs(status.steer_report - 0.25) > 1e-9) return 3;
  if (!sim->send_command(0.0, 1.0, 0.0)) return 4;
  sim->disconnect();

  auto can = ghostwheel::make_can_monitor("can0");
  if (can->is_simulation() || can->send_command(1.0, 0.0, 1.0) ||
      can->read_status().valid) return 5;
  auto serial = ghostwheel::make_serial_monitor("/dev/ttyUSB0", 115200, false);
  if (serial->send_command(1.0, 0.0, 1.0) || serial->read_status().valid) return 6;
  auto obd = ghostwheel::make_serial_monitor("/dev/ttyUSB0", 38400, true);
  if (obd->send_command(0.0, 1.0, -1.0) || obd->read_status().valid) return 7;
  return 0;
}
