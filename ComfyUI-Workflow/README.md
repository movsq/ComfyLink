# ComfyUI Workflow — Flux 2 Klein 9B GGUF (Online / Image-Edit)

This folder is the **source of truth** for the ComfyUI workflow used by the
Flux2-9B-Klein-Remote system. Load `Flux2_Klein_9B_GGUF_ONLINE.json` into
ComfyUI's UI to view, inspect, or modify the full node graph.

The Python client (`pc-client/comfyui.py`) drives this workflow via ComfyUI's
HTTP/WebSocket API at runtime. The node IDs in the JSON must stay in sync with
the IDs referenced in `comfyui.py`.

---

## What the workflow does

| Mode | Inputs | Behaviour |
|------|--------|-----------|
| Text-only | Prompt | Generates a new image from scratch |
| Image + Prompt | Image 1 + Prompt | Edits / re-imagines Image 1 |
| Multi-image + Prompt | Image 1 + Image 2 + Prompt | Composites Image 2 into the scene from Image 1 |

Images are scaled to ~1 megapixel (configurable) before being fed to the model.
A side-by-side comparison of the input and output is shown in the ComfyUI UI via
the `Image Comparer (rgthree)` node.

---

## Required Model Files

Download these into the indicated ComfyUI model directories before running.

| File | Directory | Download |
|------|-----------|----------|
| `flux-2-klein-9b-Q4_K_M.gguf` | `models/unet/` | [Hugging Face — Flux 2 Klein 9B GGUF](https://huggingface.co/city96/FLUX.2-Klein-gguf) |
| `qwen3-8b-q4_k_m.gguf` | `models/clip/` | [Hugging Face — Qwen3 8B GGUF](https://huggingface.co/city96/qwen3-8b-gguf) |
| `flux2-vae.safetensors` | `models/vae/` | [Hugging Face — Flux 2 VAE](https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors) |

> **VRAM requirement:** The Q4_K_M quant of Flux 2 Klein 9B runs comfortably
> on a GPU with 12 GB VRAM. Lower-VRAM systems may need to enable CPU offload
> in ComfyUI (`--cpu-offload`).

---

## Required Custom Node Packs

Install these via **ComfyUI Manager** (search by name) or clone directly.

| Node pack | Nodes used | GitHub |
|-----------|-----------|--------|
| **ComfyUI-GGUF** (city96) | `LoaderGGUFAdvanced`, `ClipLoaderGGUF` | [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) |
| **ComfyUi-TextEncodeEditAdvanced** (BigStationW) | `TextEncodeEditAdvanced` | [BigStationW/ComfyUi-TextEncodeEditAdvanced](https://github.com/BigStationW/ComfyUi-TextEncodeEditAdvanced) |
| **ComfyUi-Scale-Image-to-Total-Pixels-Advanced** (BigStationW) | `ImageScaleToTotalPixelsX` | [BigStationW/ComfyUi-Scale-Image-to-Total-Pixels-Advanced](https://github.com/BigStationW/ComfyUi-Scale-Image-to-Total-Pixels-Advanced) |
| **Comfyui-AD-Image-Concatenation-Advanced** (BigStationW) | `AD_image-concat-advanced` | [BigStationW/Comfyui-AD-Image-Concatenation-Advanced](https://github.com/BigStationW/Comfyui-AD-Image-Concatenation-Advanced) |
| **rgthree-comfy** | `Image Comparer` | [rgthree/rgthree-comfy](https://github.com/rgthree/rgthree-comfy) |
| **ComfyUI-Easy-Use** (ltdrdata) | `easy loadImageBase64` | [ltdrdata/ComfyUI-Easy-Use](https://github.com/ltdrdata/ComfyUI-Easy-Use) |

---

## Node Map (for `comfyui.py` reference)

| Node ID | Type | Role |
|---------|------|------|
| 99  | `KSamplerSelect` | Sampler selection |
| 100 | `SamplerCustomAdvanced` | Main sampler |
| 101 | `VAEDecode` | Latent → pixel space |
| 102 | `RandomNoise` | Seed / noise source |
| 105 | `VAELoader` | Loads `flux2-vae.safetensors` |
| 106 | `EmptyFlux2LatentImage` | Creates blank latent (size driven by Image 1) |
| 109 | `Flux2Scheduler` | Sigma schedule (steps, size-aware) |
| 115 | `ImageScaleToTotalPixelsX` | Scales Image 1 to ~1 MP |
| 117 | `PreviewImage` | Output preview |
| 118 | `PreviewImage` | Composited debug preview |
| 119 | `Image Comparer (rgthree)` | Side-by-side input/output |
| 133 | `ImageScaleToTotalPixelsX` | Scales Image 2 to ~1 MP |
| 139 | `BasicGuider` | Guidance combiner |
| 156 | `TextEncodeEditAdvanced` | Prompt + image-reference encoding |
| 159 | `AD_image-concat-advanced` | Vertically concatenates Image 1 + Image 2 |
| 161 | `AD_image-concat-advanced` | Horizontally concatenates inputs + output |
| 163 | `LoaderGGUFAdvanced` | Loads `flux-2-klein-9b-Q4_K_M.gguf` |
| 164 | `ClipLoaderGGUF` | Loads `qwen3-8b-q4_k_m.gguf` CLIP |
| 175 | `easy loadImageBase64` | Image 1 input (base64) |
| 176 | `easy loadImageBase64` | Image 2 input (base64) |

---

## Customising the Workflow

To change the default prompt, steps, or sampler, edit the widget values of the
corresponding nodes in ComfyUI's UI and re-save the JSON, **or** override them
programmatically via the `pc-client/comfyui.py` parameter injection.

If you add, remove, or renumber nodes, update the node ID constants at the top
of `pc-client/comfyui.py` accordingly.
