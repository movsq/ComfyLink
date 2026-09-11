"""Shared validation for decrypted generation parameters."""

MIN_STEPS = 1
MAX_STEPS = 8

MIN_SEED = 0
# Matches the client-side cap. 2^32 - 1 is well below JS's MAX_SAFE_INTEGER and
# avoids float-precision issues in the browser's increment path.
MAX_SEED = 2**32 - 1

# LoraLoader accepts any float, but anything outside this range is either a
# no-op or destroys the image — clamp rather than reject so a slightly
# out-of-range slider value still produces a picture.
MIN_LORA_STRENGTH = 0.0
MAX_LORA_STRENGTH = 2.0


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


def validate_lora_strength(value) -> float:
    """Validate a LoRA strength and clamp it into 0..2.

    Rejects bool and non-numeric input outright (a string here would reach
    ComfyUI as-is), then clamps. NaN is rejected because it compares false
    against both bounds and would slip through the clamp unchanged.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Invalid loraStrength: must be a number")
    strength = float(value)
    if strength != strength:  # NaN
        raise ValueError("Invalid loraStrength: must be a number")
    return max(MIN_LORA_STRENGTH, min(MAX_LORA_STRENGTH, strength))
