# Mirror of dataspeed_dbw_msgs SteerByWire Report / NestedReport common fields.
std_msgs/Header header
float64 angle         # steering wheel angle in radians (NOT tire angle)
float64 speed
float64 torque
bool override
bool error
