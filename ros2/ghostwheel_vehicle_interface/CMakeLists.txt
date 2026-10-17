cmake_minimum_required(VERSION 3.14)
project(ghostwheel_vehicle_interface)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(ament_cmake REQUIRED)
find_package(rosidl_default_generators REQUIRED)
find_package(rclcpp REQUIRED)
find_package(std_msgs REQUIRED)
find_package(autoware_vehicle_msgs REQUIRED)
find_package(autoware_control_msgs REQUIRED)
# Optional: the core simulator and passive HAL build without PACMod3 installed.
find_package(pacmod3_msgs QUIET)

add_library(ghostwheel_hal
  src/hal_sim.cpp
  src/hal_can.cpp
  src/hal_serial.cpp
)
target_include_directories(ghostwheel_hal PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>)
target_compile_options(ghostwheel_hal PRIVATE -Wall -Wextra -Wpedantic)

add_executable(ghostwheel_vehicle_interface
  src/ghostwheel_vehicle_interface.cpp)
target_link_libraries(ghostwheel_vehicle_interface ghostwheel_hal)
ament_target_dependencies(ghostwheel_vehicle_interface
  rclcpp std_msgs autoware_vehicle_msgs autoware_control_msgs)
target_compile_options(ghostwheel_vehicle_interface PRIVATE -Wall -Wextra -Wpedantic)

if(pacmod3_msgs_FOUND)
  find_package(std_srvs REQUIRED)
  add_executable(ghostwheel_pacmod3_adapter src/pacmod3_observer.cpp)
  target_include_directories(ghostwheel_pacmod3_adapter PRIVATE include)
  target_compile_options(ghostwheel_pacmod3_adapter PRIVATE -Wall -Wextra -Wpedantic)
  ament_target_dependencies(ghostwheel_pacmod3_adapter
    rclcpp std_msgs std_srvs pacmod3_msgs
    autoware_vehicle_msgs autoware_control_msgs)
  install(TARGETS ghostwheel_pacmod3_adapter
    RUNTIME DESTINATION lib/${PROJECT_NAME})
else()
  message(STATUS "PACMod3 message package not found: ROS observer target disabled")
endif()

# Dataspeed DBW observation adapter (Option B). Preferred build path is the
# vendor message package `dataspeed_dbw_msgs` (https://github.com/DataspeedInc/dataspeed_dbw_msgs).
# When it is absent, the adapter builds against the field-compatible report
# mirrors in msg/ (see msg/README.md): same field names and enum values, so
# topics remap onto vendor messages without code changes. Command interfaces
# are deliberately NOT mirrored; the adapter has no command publisher.
find_package(dataspeed_dbw_msgs QUIET)
if(NOT dataspeed_dbw_msgs_FOUND)
  message(STATUS "Vendor dataspeed_dbw_msgs not found: building the Dataspeed "
                 "adapter against the local report mirrors in msg/")
  rosidl_generate_interfaces(${PROJECT_NAME}_dataspeed_mirrors
    msg/DataspeedDbwStatus.msg
    msg/DataspeedSpeedReport.msg
    msg/DataspeedAcceleratorReport.msg
    msg/DataspeedBrakeReport.msg
    msg/DataspeedSteeringReport.msg
    DEPENDENCIES std_msgs
  )
  rosidl_get_typesupport_target(cpp_typesupport_target
    ${PROJECT_NAME}_dataspeed_mirrors rosidl_typesupport_cpp)
  if(NOT cpp_typesupport_target)
    message(FATAL_ERROR
      "rosidl typesupport target missing: cannot build the Dataspeed adapter")
  endif()

  # Generate a compatibility header aliasing the local mirror types to the
  # vendor type names used by src/dataspeed_observer.cpp.
  file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/gen/include/dataspeed_dbw_msgs/msg/dbw_status.hpp" CONTENT "
#pragma once
#include <ghostwheel_vehicle_interface_dataspeed_mirrors/msg/dbw_status.hpp>
namespace dataspeed_dbw_msgs { namespace msg { using DbwStatus = ::ghostwheel_vehicle_interface_dataspeed_mirrors::msg::DbwStatus; } }")
  file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/gen/include/dataspeed_dbw_msgs/msg/speed_report.hpp" CONTENT "
#pragma once
#include <ghostwheel_vehicle_interface_dataspeed_mirrors/msg/speed_report.hpp>
namespace dataspeed_dbw_msgs { namespace msg { using SpeedReport = ::ghostwheel_vehicle_interface_dataspeed_mirrors::msg::SpeedReport; } }")
  file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/gen/include/dataspeed_dbw_msgs/msg/accelerator_report.hpp" CONTENT "
#pragma once
#include <ghostwheel_vehicle_interface_dataspeed_mirrors/msg/accelerator_report.hpp>
namespace dataspeed_dbw_msgs { namespace msg { using AcceleratorReport = ::ghostwheel_vehicle_interface_dataspeed_mirrors::msg::AcceleratorReport; } }")
  file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/gen/include/dataspeed_dbw_msgs/msg/brake_report.hpp" CONTENT "
#pragma once
#include <ghostwheel_vehicle_interface_dataspeed_mirrors/msg/brake_report.hpp>
namespace dataspeed_dbw_msgs { namespace msg { using BrakeReport = ::ghostwheel_vehicle_interface_dataspeed_mirrors::msg::BrakeReport; } }")
  file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/gen/include/dataspeed_dbw_msgs/msg/steer_by_wire_report.hpp" CONTENT "
#pragma once
#include <ghostwheel_vehicle_interface_dataspeed_mirrors/msg/steering_report.hpp>
namespace dataspeed_dbw_msgs { namespace msg { using SteerByWireReport = ::ghostwheel_vehicle_interface_dataspeed_mirrors::msg::SteeringReport; } }")

  add_executable(ghostwheel_dataspeed_adapter src/dataspeed_observer.cpp)
  # include/: shared observer state model; gen/include/: vendor-name aliases.
  target_include_directories(ghostwheel_dataspeed_adapter PRIVATE
    include "${CMAKE_CURRENT_BINARY_DIR}/gen/include")
  target_compile_options(ghostwheel_dataspeed_adapter PRIVATE -Wall -Wextra -Wpedantic)
  target_link_libraries(ghostwheel_dataspeed_adapter "${cpp_typesupport_target}")
  ament_target_dependencies(ghostwheel_dataspeed_adapter
    rclcpp std_msgs std_srvs
    autoware_vehicle_msgs autoware_control_msgs)
  install(TARGETS ghostwheel_dataspeed_adapter
    RUNTIME DESTINATION lib/${PROJECT_NAME})
else()
  find_package(std_srvs REQUIRED)
  add_executable(ghostwheel_dataspeed_adapter src/dataspeed_observer.cpp)
  target_include_directories(ghostwheel_dataspeed_adapter PRIVATE include)
  target_compile_options(ghostwheel_dataspeed_adapter PRIVATE -Wall -Wextra -Wpedantic)
  ament_target_dependencies(ghostwheel_dataspeed_adapter
    rclcpp std_msgs std_srvs dataspeed_dbw_msgs
    autoware_vehicle_msgs autoware_control_msgs)
  install(TARGETS ghostwheel_dataspeed_adapter
    RUNTIME DESTINATION lib/${PROJECT_NAME})
endif()

install(TARGETS ghostwheel_hal ghostwheel_vehicle_interface
  ARCHIVE DESTINATION lib
  LIBRARY DESTINATION lib
  RUNTIME DESTINATION lib/${PROJECT_NAME})
install(DIRECTORY include/ DESTINATION include)
install(DIRECTORY config/ DESTINATION share/${PROJECT_NAME}/config)
include(CTest)
if(BUILD_TESTING)
  add_executable(ghostwheel_hal_contract_test tests/hal_contract_test.cpp)
  target_link_libraries(ghostwheel_hal_contract_test ghostwheel_hal)
  add_test(NAME ghostwheel_hal_contract_test COMMAND ghostwheel_hal_contract_test)
  # Shared observer-state decision logic (used by both DBW adapters).
  add_executable(ghostwheel_dbw_observer_state_test tests/dbw_observer_state_test.cpp)
  target_include_directories(ghostwheel_dbw_observer_state_test PRIVATE include)
  target_compile_options(ghostwheel_dbw_observer_state_test PRIVATE -Wall -Wextra -Wpedantic)
  add_test(NAME ghostwheel_dbw_observer_state_test
    COMMAND ghostwheel_dbw_observer_state_test)
  # Backwards-compatible alias kept for the existing PACMod test contract.
  add_executable(ghostwheel_pacmod_observer_state_test tests/pacmod_observer_state_test.cpp)
  target_include_directories(ghostwheel_pacmod_observer_state_test PRIVATE include)
  add_test(NAME ghostwheel_pacmod_observer_state_test
    COMMAND ghostwheel_pacmod_observer_state_test)
endif()
ament_package()
