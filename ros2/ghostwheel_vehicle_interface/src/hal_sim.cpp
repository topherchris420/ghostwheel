#include "ghostwheel/hal.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>

namespace ghostwheel {
namespace {

class SimulationHal final : public VehicleHardwareInterface {
 public:
  bool connect(std::string & reason) override {
    connected_ = true;
    last_update_ = std::chrono::steady_clock::now();
    reason = "synthetic model ready";
    return true;
  }

  void disconnect() noexcept override {
    connected_ = false;
    accel_ = 0.0;
    brake_ = 1.0;
    steer_ = 0.0;
  }

  bool send_command(double accel, double brake, double steer) override {
    if (!connected_) return false;
    accel_ = std::clamp(accel, 0.0, 1.0);
    brake_ = std::clamp(brake, 0.0, 1.0);
    steer_ = std::clamp(steer, -1.0, 1.0);
    return true;
  }

  VehicleStatus read_status() override {
    if (!connected_) return {};
    const auto now = std::chrono::steady_clock::now();
    const double elapsed = std::chrono::duration<double>(now - last_update_).count();
    last_update_ = now;
    // Demonstration-only kinematics, not a real vehicle dynamics model.
    const double dt = std::clamp(elapsed, 0.0, 0.1);
    speed_ = std::clamp(speed_ + (3.0 * accel_ - 8.0 * brake_ - 0.04 * speed_) * dt,
                        0.0, 15.0);
    const double tire_angle_rad = steer_ * 0.35;
    ++samples_;
    return {true, accel_, brake_, steer_, speed_, 0.0,
            speed_ * std::tan(tire_angle_rad) / 2.7};
  }

  std::uint64_t observations() const noexcept override { return samples_; }
  bool is_simulation() const noexcept override { return true; }

 private:
  bool connected_{false};
  double accel_{0.0};
  double brake_{1.0};
  double steer_{0.0};
  double speed_{0.0};
  std::uint64_t samples_{0};
  std::chrono::steady_clock::time_point last_update_{};
};
}  // namespace

std::unique_ptr<VehicleHardwareInterface> make_sim_interface() {
  return std::make_unique<SimulationHal>();
}
}  // namespace ghostwheel
