"""Optional CARLA-only bridge. This module cannot open a physical vehicle bus."""
from __future__ import annotations

import importlib
import math

from .connectors import CARLA_DESCRIPTOR
from .model import DT


class CarlaAdapter:
    descriptor = CARLA_DESCRIPTOR

    def __init__(self, blueprint='vehicle.tesla.model3', seed=42, port=2000):
        self.carla = importlib.import_module('carla')
        self.client = self.carla.Client('127.0.0.1', port)
        self.client.set_timeout(5.0)
        client_version = self.client.get_client_version()
        server_version = self.client.get_server_version()
        if client_version != server_version:
            raise RuntimeError(f'CARLA version mismatch: client {client_version}, server {server_version}')
        self.metadata = {'client_version': client_version, 'server_version': server_version,
            'seed': seed, 'blueprint': blueprint, 'dt_s': DT,
            'host': '127.0.0.1', 'port': port, 'synchronous_mode': True,
            'max_substep_delta_time': 0.01, 'max_substeps': 10}
        self.actor = None
        self.original_settings = None
        self.world = self.client.get_world()
        actors = self.world.get_actors()
        if list(actors.filter('vehicle.*')) or list(actors.filter('walker.*')):
            raise RuntimeError('CARLA world must be empty; existing actors will not be modified')
        self.original_settings = self.world.get_settings()
        try:
            settings = self.world.get_settings()
            settings.synchronous_mode = True
            settings.fixed_delta_seconds = DT
            settings.substepping = True
            settings.max_substep_delta_time = 0.01
            settings.max_substeps = 10
            self.world.apply_settings(settings)
            self.world = self.client.reload_world(False)
            library = self.world.get_blueprint_library()
            bp = library.find(blueprint)
            bp.set_attribute('role_name', 'ghostwheel_simulation_only')
            points = self.world.get_map().get_spawn_points()
            if not points:
                raise RuntimeError('CARLA map has no vehicle spawn points')
            for offset in range(min(12, len(points))):
                point = points[(seed + offset) % len(points)]
                self.actor = self.world.try_spawn_actor(bp, point)
                if self.actor:
                    break
            if self.actor is None:
                raise RuntimeError('Could not spawn an owned CARLA vehicle')
            self.world.tick()
            pose = self.actor.get_transform()
            self.metadata.update(map=self.world.get_map().name,
                spawn={'x': pose.location.x, 'y': pose.location.y, 'z': pose.location.z,
                       'yaw': pose.rotation.yaw, 'pitch': pose.rotation.pitch, 'roll': pose.rotation.roll})
            # CARLA normalized steer is not a measurement of tire angle.
            self.last_observation = None
        except Exception:
            self.close()
            raise

    def apply_and_tick(self, virtual_vehicle):
        command = self.carla.VehicleControl(throttle=virtual_vehicle.throttle,
            steer=virtual_vehicle.steer_deg / virtual_vehicle.arch.max_steer_deg,
            brake=virtual_vehicle.brake)
        responses = self.client.apply_batch_sync([self.carla.command.ApplyVehicleControl(self.actor.id, command)], False)
        if not responses or responses[0].error:
            raise RuntimeError('CARLA rejected the owned-actor control batch')
        frame = self.world.tick()
        transform, velocity = self.actor.get_transform(), self.actor.get_velocity()
        self.last_observation = {'frame': frame, 'x_m': transform.location.x, 'y_m': transform.location.y,
            'yaw_rad': math.radians(transform.rotation.yaw),
            'speed_mps': math.sqrt(velocity.x**2 + velocity.y**2 + velocity.z**2),
            'steer_normalized': command.steer,
            'front_left_wheel_steer_deg': self.actor.get_wheel_steer_angle(self.carla.VehicleWheelLocation.FL_Wheel)}
        return self.last_observation

    def close(self):
        errors = []
        if self.actor:
            try:
                self.actor.apply_control(self.carla.VehicleControl(throttle=0.0, steer=0.0, brake=1.0))
                self.actor.destroy()
            except Exception as error:
                errors.append(str(error))
            self.actor = None
        if self.original_settings is not None:
            try:
                self.world.apply_settings(self.original_settings)
            except Exception as error:
                errors.append(str(error))
            self.original_settings = None
        if errors:
            raise RuntimeError('CARLA cleanup failed: ' + '; '.join(errors))


def availability():
    try:
        module = importlib.import_module('carla')
        return {'available': True, 'connected': False,
                'reason': 'Python CARLA client installed; local simulator server has not been verified',
                'client_version': getattr(module, '__version__', 'unknown')}
    except ImportError:
        return {'available': False, 'connected': False,
                'reason': 'Optional CARLA Python client is not installed; builtin simulation remains fully functional'}
