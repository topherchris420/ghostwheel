#include "ghostwheel/hal.hpp"

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <utility>

#ifdef __linux__
#include <fcntl.h>
#include <termios.h>
#include <unistd.h>
#endif

namespace ghostwheel {
namespace {
#ifdef __linux__
speed_t baud_constant(int baud) {
  switch (baud) {
    case 9600: return B9600;
    case 38400: return B38400;
    case 57600: return B57600;
    case 115200: return B115200;
    default: return static_cast<speed_t>(0);
  }
}
#endif

class SerialMonitor final : public VehicleHardwareInterface {
 public:
  SerialMonitor(std::string port, int baud, bool obd)
      : port_(std::move(port)), baud_(baud), obd_(obd) {}
  ~SerialMonitor() override { disconnect(); }

  bool connect(std::string & reason) override {
#ifdef __linux__
    disconnect();
    if (port_.rfind("/dev/", 0) != 0) {
      reason = "serial_port must be a local /dev/ path"; return false;
    }
    const speed_t speed = baud_constant(baud_);
    if (!speed) { reason = "unsupported baud_rate"; return false; }
    fd_ = ::open(port_.c_str(), O_RDONLY | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
    if (fd_ < 0) { reason = std::strerror(errno); return false; }
    struct termios tio {};
    if (::tcgetattr(fd_, &tio) != 0) {
      reason = std::strerror(errno); disconnect(); return false;
    }
    ::cfmakeraw(&tio);
    tio.c_cflag |= CLOCAL | CREAD;
    if (::cfsetispeed(&tio, speed) != 0 || ::cfsetospeed(&tio, speed) != 0 ||
        ::tcsetattr(fd_, TCSANOW, &tio) != 0) {
      reason = std::strerror(errno); disconnect(); return false;
    }
    reason = obd_ ? "OBD serial receive-only; ELM327 polling NOT implemented"
                  : "custom UART receive-only; decoder NOT implemented";
    return true;
#else
    reason = "serial monitoring requires Linux"; return false;
#endif
  }

  void disconnect() noexcept override {
#ifdef __linux__
    if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
#endif
  }

  bool send_command(double, double, double) override {
    // No ASCII control strings, custom motor instructions, or UART writes.
    return false;
  }

  VehicleStatus read_status() override {
#ifdef __linux__
    if (fd_ >= 0) {
      std::uint8_t buf[256];
      for (int i = 0; i < 8; ++i) {
        const ssize_t n = ::read(fd_, buf, sizeof(buf));
        if (n > 0) bytes_seen_ += static_cast<std::uint64_t>(n);
        else {
          if (n < 0 && errno == EINTR) continue;
          break;
        }
      }
    }
#endif
    // Read bytes without inventing a physical measurement from unknown protocols.
    return {};
  }

  std::uint64_t observations() const noexcept override { return bytes_seen_; }
  bool is_simulation() const noexcept override { return false; }

 private:
  std::string port_;
  int baud_;
  bool obd_;
  int fd_{-1};
  std::uint64_t bytes_seen_{0};
};
}  // namespace

std::unique_ptr<VehicleHardwareInterface> make_serial_monitor(
    const std::string & port, int baud_rate, bool obd_mode) {
  return std::make_unique<SerialMonitor>(port, baud_rate, obd_mode);
}
}  // namespace ghostwheel
