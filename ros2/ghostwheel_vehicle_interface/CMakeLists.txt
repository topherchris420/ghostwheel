cmake_minimum_required(VERSION 3.14)
project(ghostwheel_vehicle_interface)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(ament_cmake REQUIRED)
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

# Dataspeed (Option B): native ROS message types are mandatory for live
# observation. Local look-alike IDL is NOT wire-compatible with a vendor
# publisher, even if a C++ using-alias shares the same field names.
# Keep the core simulator and PACMod observer buildable without Dataspeed.
find_package(dataspeed_dbw_msgs QUIET)
if(dataspeed_dbw_msgs_FOUND)
  find_package(std_srvs REQUIRED)
  add_executable(ghostwheel_dataspeed_adapter src/dataspeed_observer.cpp)
  target_include_directories(ghostwheel_dataspeed_adapter PRIVATE include)
  target_compile_options(ghostwheel_dataspeed_adapter PRIVATE -Wall -Wextra -Wpedantic)
  ament_target_dependencies(ghostwheel_dataspeed_adapter
    rclcpp std_msgs std_srvs dataspeed_dbw_msgs
    autoware_vehicle_msgs autoware_control_msgs)
  install(TARGETS ghostwheel_dataspeed_adapter
    RUNTIME DESTINATION lib/${PROJECT_NAME})
else()
  message(STATUS "Native dataspeed_dbw_msgs not found: read-only Dataspeed observer target disabled")
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
