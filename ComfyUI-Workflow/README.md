# ComfyUI Workflow — Flux 2 Klein 9B GGUF (Online / Image-Edit)

This folder contains the **visual workflow** for the Flux2-9B-Klein-Remote
system. `Flux2_Klein_9B_GGUF_ONLINE.json` is a standard ComfyUI graph-format
save file — you can load it into ComfyUI's UI to view, inspect, or modify the
node graph.

### Two workflow formats

| File | Format | Purpose |
|------|--------|---------|
| `ComfyUI-Workflow/Flux2_Klein_9B_GGUF_ONLINE.json` | ComfyUI graph format (nodes, links, positions, UI metadata) | Visual reference — drag-and-drop into ComfyUI's canvas to inspect or edit |
| `pc-client/workflow_template.json` | ComfyUI **API format** (keyed by node ID, with `inputs` / `class_type`) | What the pc-client actually submits to ComfyUI's `/prompt` endpoint at runtime |

The Python client (`pc-client/comfyui.py`) loads `workflow_template.json` at
startup, deep-copies it per job, injects the job parameters (prompt, images,
seed, steps, sampler), prunes unused nodes based on image count, then POSTs
the result to ComfyUI's HTTP API. **It does not read or use the visual
workflow JSON in this folder.**

If you modify the visual workflow (add/remove/renumber nodes), you must
re-export the API format and update `pc-client/workflow_template.json` to
match — and update the node IDs referenced in `pc-client/comfyui.py`.

---

## What the workflow does

| Mode | Inputs | Behaviour |
|------|--------|-----------|
| Text-only | Prompt | Generates a new image from scratch (latent hardcoded to 1024×1024) |
| Image + Prompt | Image 1 + Prompt | Edits / re-imagines Image 1 |
| Multi-image + Prompt | Image 1 + Image 2 + Prompt | Composites Image 2 into the scene from Image 1 |
Any mode can additionally apply a **LoRA adapter** (node 181) with a configurable strength. When `lora` is set to anything other than `"none"`, node 181 is wired between the model/CLIP loaders and their consumers; otherwise it is removed from the workflow entirely.
Images are uploaded to ComfyUI's input directory via `POST /upload/image`,
then referenced by filename in the native `LoadImage` nodes (177 / 178). They
are scaled to ~1 megapixel before being fed to the model. A side-by-side
comparison of the input and output is shown in ComfyUI's UI via the
`Image Comparer (rgthree)` node.

---

## Required Model Files

Download these into the indicated ComfyUI model directories before running.

| File | Directory | Download |
|------|-----------|----------|
| `flux-2-klein-9b-Q4_K_M.gguf` (default), `Q5_K_M`, `Q6_K`, or `Q8_0` variant | `models/unet/` | [Hugging Face — FLUX.2-klein-9B-GGUF (all quants)](https://huggingface.co/unsloth/FLUX.2-klein-9B-GGUF/tree/main) — download the quant you want |
| `qwen3-8b-q4_k_m.gguf` | `models/clip/` | [Hugging Face — Qwen3 8B GGUF](https://huggingface.co/Aldaris/Qwen3-8B-Q4_K_M-GGUF/blob/main/qwen3-8b-q4_k_m.gguf) |
| `flux2-vae.safetensors` | `models/vae/` | [Hugging Face — Flux 2 VAE](https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors) |

> **VRAM requirement:** Q4_K_M (default, ~5.9 GB) runs comfortably on 12 GB VRAM.
> Larger quants need proportionally more: Q5_K_M ~7 GB, Q6_K ~7.9 GB, Q8_0 ~10 GB.
> Lower-VRAM systems may need to enable CPU offload in ComfyUI (`--cpu-offload`).

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
| 117 | `PreviewImage` | Output preview (pc-client reads result from this node) |
| 118 | `PreviewImage` | Composited debug preview (2-image mode only) |
| 119 | `Image Comparer (rgthree)` | Side-by-side input/output (1- and 2-image modes) |
| 133 | `ImageScaleToTotalPixelsX` | Scales Image 2 to ~1 MP (2-image mode only) |
| 139 | `BasicGuider` | Guidance combiner |
| 156 | `TextEncodeEditAdvanced` | Prompt + image-reference encoding |
| 159 | `AD_image-concat-advanced` | Vertically concatenates Image 1 + Image 2 (2-image mode only) |
| 161 | `AD_image-concat-advanced` | Horizontally concatenates inputs + output (2-image mode only) |
| 163 | `LoaderGGUFAdvanced` | Loads the GGUF unet model (quant chosen at job time; default `Q4_K_M`) |
| 164 | `ClipLoaderGGUF` | Loads `qwen3-8b-q4_k_m.gguf` CLIP |
| 177 | `LoadImage` | Image 1 input (filename set at runtime) |
| 178 | `LoadImage` | Image 2 input (filename set at runtime, 2-image mode only) |
| 181 | `LoraLoader` | Optional LoRA adapter — wired between model/CLIP loaders and consumers when `lora ≠ "none"`, removed otherwise |

### Node pruning by image count

`comfyui.py` dynamically removes nodes that aren't needed:

| Mode | Nodes removed |
|------|---------------|
| 2 images | *(none)* |
| 1 image | 178, 133, 159, 161, 118 |
| 0 images (text-only) | 177, 178, 133, 115, 159, 161, 118, 119 |

### LoRA pruning

Node 181 is handled separately from the image-count pruning:

| `lora` param | Effect |
|---|---|
| `"none"` or unset | Node 181 removed; direct connections preserved: `[163,0] → [139]` (model), `[164,0] → [156]` (clip) |
| Any LoRA filename | Node 181 wired in: `[163,0] → [181] → [139]` (model), `[164,0] → [181] → [156]` (clip); `strength_model` set to `loraStrength`, `strength_clip` fixed at 1.0 |

---

## Customising the Workflow

1. Open `Flux2_Klein_9B_GGUF_ONLINE.json` in ComfyUI's visual editor.
2. Make your changes (add/remove nodes, change defaults, etc.).
3. Export the API format: **Menu → Save (API Format)** — or use *Developer Mode*
   to copy the API JSON.
4. Replace `pc-client/workflow_template.json` with the new API-format export.
5. Update any changed node IDs in `pc-client/comfyui.py`.
