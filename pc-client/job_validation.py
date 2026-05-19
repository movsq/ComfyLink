"""Shared validation for decrypted generation parameters."""

MIN_STEPS = 1
MAX_STEPS = 8

MIN_SEED = 0
# Matches the client-side cap. 2^32 - 1 is well below JS's MAX_SAFE_INTEGER and
# avoids float-precision issues in the browser's increment path.
MAX_SEED = 2**32 - 1


def _validate_int_range(value, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"Invalid {field}: must be an integer")
    if value < minimum or value > maximum:
        raise ValueError(f"Invalid {field}: must be between {minimum} and {maximum}")
    return value


def validate_seed(value) -> int:
    """Validate a ComfyUI noise seed within the shared client/PC range (0..2^32-1)."""
    return _validate_int_range(value, "seed", MIN_SEED, MAX_SEED)


def validate_steps(value) -> int:
    """Validate the supported Flux2 scheduler step range."""
    return _validate_int_range(value, "steps", MIN_STEPS, MAX_STEPS)
