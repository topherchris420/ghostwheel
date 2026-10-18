// GHOSTWHEEL / GW-01 - ASTER exploded research model
// Parametric OpenSCAD teaching artifact. MIT license.
\n// Source: https://github.com/topherchris420/ghostwheel
// This is a conceptual physical visualization of a software simulator.
// NO automotive manufacturing dimensions, electronics design, CAN wiring,
// motion-control hardware, or physical vehicle functionality are specified.
// ASTER wheelbase is the ONLY vehicle dimension taken from the model.
$fn = 48;

wheelbase_mm = 2650;              // Repo model: 2.65 m
body_length_mm = 4050;            // illustrative
body_width_mm = 1740;             // illustrative
track_width_mm = 1550;            // illustrative
wheel_radius_mm = 325;            // illustrative
wheel_width_mm = 210;             // illustrative
exploded = true;                  // flip to false for an assembled layout
show_abstract_software = true;    // electronics symbols, not real parts
explode_shell_mm = exploded ? 630 : 0;
explode_software_mm = exploded ? 160 : 0;

module beam(size, xyz, tint) {
  color(tint) translate(xyz) cube(size, center=true);
}
module wheel(axle_x, side) {
  translate([axle_x, side * track_width_mm/2, wheel_radius_mm]) {
    color([0.07,0.17,0.22]) rotate([90,0,0])
      cylinder(r=wheel_radius_mm, h=wheel_width_mm, center=true);
    color([0.25,0.83,0.88]) rotate([90,0,0])
      cylinder(r=wheel_radius_mm*0.38, h=wheel_width_mm+2, center=true);
  }
}
module chassis() {
  color([0.14,0.34,0.43]) {
    translate([0,0,490]) cube([wheelbase_mm+610,body_width_mm*0.72,110],center=true);
    for(y=[-body_width_mm*0.38,body_width_mm*0.38])
      translate([0,y,540]) cube([body_length_mm*0.83,76,95],center=true);
  }
  color([0.21,0.65,0.72,0.65])
    translate([0,0,573]) cube([2400,1250,12],center=true);
}
module body_shell() {
  color([0.17,0.55,0.65,0.43]) {
    hull() {
      translate([-1380,0,930]) cube([1000,body_width_mm,240],center=true);
      translate([320,0,980]) cube([2050,body_width_mm,410],center=true);
      translate([1530,0,935]) cube([650,body_width_mm,220],center=true);
    }
    hull() {
      translate([-390,0,1240]) cube([900,body_width_mm*0.75,140],center=true);
      translate([400,0,1320]) cube([1150,body_width_mm*0.72,170],center=true);
    }
  }
}
module software_block(pos, size, tint) {
  color(tint) translate(pos) cube(size,center=true);
}
module synthetic_bus() {
  color([0.23,0.88,0.91]) {
    translate([0,0,650]) cube([2680,16,17],center=true);
    for(x=[-850,0,850])
      translate([x,0,650]) cube([16,1100,17],center=true);
  }
}
module research_stack() {
  // Virtual components are deliberately schematic, not hardware layouts.
  software_block([-810,0,800+explode_software_mm],
                 [260,340,145],[0.72,0.55,0.84]); // authorization gateway
  software_block([120,0,800+explode_software_mm],
                 [320,340,145],[0.44,0.73,0.89]); // virtual EPS
  software_block([820,0,800+explode_software_mm],
                 [230,280,145],[0.22,0.86,0.84]); // model + telemetry
}
for(axle_x=[-wheelbase_mm/2,wheelbase_mm/2])
  for(side=[-1,1]) wheel(axle_x,side);
chassis();
if(show_abstract_software) {
  synthetic_bus();
  research_stack();
}
translate([0,0,explode_shell_mm]) body_shell();
