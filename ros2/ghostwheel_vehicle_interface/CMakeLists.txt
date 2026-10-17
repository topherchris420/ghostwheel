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
endif()
ament_package()
