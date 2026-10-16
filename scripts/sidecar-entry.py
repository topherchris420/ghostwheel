"""Frozen application entrypoint. No privileged or vehicle hardware access."""
from ghostwheel.server import main

if __name__ == "__main__":
    main()
