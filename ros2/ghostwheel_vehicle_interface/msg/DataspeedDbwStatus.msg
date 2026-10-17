# Compatibility mirror of dataspeed_dbw_msgs/msg/DbwStatus (ROS 2).
# Field names and constant values match the public Dataspeed DBW interface so
# topics can be remapped onto vendor messages without code changes.
uint8 STATUS_NORMALLY_OFF=0
uint8 STATUS_ENGAGED=1
uint8 STATUS_PREEMPTED=2
uint8 STATUS_OVERIDDEN=3
uint8 STATUS_FAULT=4
uint8 STATUS_SEVERELY_FAULTY=5
uint8 STATUS_SHUTDOWN_REQUESTED=6
uint8 STATUS_REBOOTING=7

bool engaged
bool ready
uint8 status
bool fault_brake
bool fault_epas
bool fault_ebs
bool fault_ems
bool fault_tcu
bool fault_can
bool fault_no_tx
bool fault_button
bool preempted_brake
bool preempted_throttle
bool preempted_front_eha
bool preempted_rear_eha
bool preempted_epas
bool preempted_gear
float64 command_timeout
float64 dbw_control_timeout
string message
