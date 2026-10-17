#include "ghostwheel/hal.hpp"

#include <cerrno>
#include <cstring>
#include <memory>
#include <string>
#include <utility>

#ifdef __linux__
#include <fcntl.h>
#include <linux/can.h>
#include <linux/can/raw.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace ghostwheel {
namespace {
class CanMonitor final : public VehicleHardwareInterface {
 public:
  explicit CanMonitor(std::string device) : device_(std::move(device)) {}
  ~CanMonitor() override { disconnect(); }

  bool connect(std::string & reason) override {
#ifdef __linux__
    disconnect();
    if (device_.empty() || device_.size() >= IFNAMSIZ) {
      reason = "invalid CAN interface name"; return false;
    }
    fd_ = ::socket(PF_CAN, SOCK_RAW | SOCK_NONBLOCK | SOCK_CLOEXEC, CAN_RAW);
    if (fd_ < 0) { reason = std::strerror(errno); return false; }
    struct ifreq ifr {};
    std::strncpy(ifr.ifr_name, device_.c_str(), IFNAMSIZ - 1);
    if (::ioctl(fd_, SIOCGIFINDEX, &ifr) != 0) {
      reason = std::strerror(errno); disconnect(); return false;
    }
    struct sockaddr_can address {};
    address.can_family = AF_CAN;
    address.can_ifindex = ifr.ifr_ifindex;
    if (::bind(fd_, reinterpret_cast<struct sockaddr *>(&address), sizeof(address)) != 0) {
      reason = std::strerror(errno); disconnect(); return false;
    }
    reason = "SocketCAN opened for passive observation only";
    return true;
#else
    reason = "SocketCAN monitoring requires Linux"; return false;
#endif
  }

  void disconnect() noexcept override {
#ifdef __linux__
    if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
#endif
  }

  bool send_command(double, double, double) override {
    // Deliberate invariant: no write(), send(), or sendto() on a real CAN bus.
    // No STEER_CMD_ID / BRAKE_CMD_ID / throttle IDs or DBC actuation maps here.
    return false;
  }

  VehicleStatus read_status() override {
#ifdef __linux__
    if (fd_ >= 0) {
      struct can_frame frame {};
      for (int i = 0; i < 128; ++i) {
        const ssize_t n = ::read(fd_, &frame, sizeof(frame));
        if (n == static_cast<ssize_t>(sizeof(frame))) {
          ++frames_seen_;
        } else {
          if (n < 0 && errno == EINTR) continue;
          break;
        }
      }
    }
#endif
    // Until an OEM-authorized, independently validated read-only DBC is provided,
    // arbitrary bus traffic MUST NOT be represented as actuator or speed feedback.
    return {};
  }

  std::uint64_t observations() const noexcept override { return frames_seen_; }
  bool is_simulation() const noexcept override { return false; }

 private:
  std::string device_;
  int fd_{-1};
  std::uint64_t frames_seen_{0};
};
}  // namespace

std::unique_ptr<VehicleHardwareInterface> make_can_monitor(const std::string & device) {
  return std::make_unique<CanMonitor>(device);
}
}  // namespace ghostwheel
