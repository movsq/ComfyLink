# ComfyUI Workflow — Flux 2 Klein 9B GGUF (Online / Image-Edit)

This folder contains the **visual workflow** for ComfyLink. `Flux2_Klein_9B_GGUF_ONLINE.json` is a standard ComfyUI graph-format
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

> **Filenames are case-sensitive on Linux** and are matched exactly — by the
> client's dropdown, by the pc-client's allow-list, and by ComfyUI itself.
> `Flux-2-Klein-9B-KV-Q4_K_M.gguf` and `flux-2-klein-9b-q4_k_m.gguf` are two
> different files. Download them under the names below, unchanged.

**Diffusion model** — `models/unet/`. The app's dropdown offers exactly these six;
**`Flux-2-Klein-9B-KV-Q4_K_M.gguf` is the client's default**, so download at
least that one. `flux-2-klein-9b-Q4_K_M.gguf` is the pc-client's own fallback,
used when a job arrives without a model choice.

| File | Size | Source |
|------|------|--------|
| `Flux-2-Klein-9B-KV-Q4_K_M.gguf` (**client default**) | 5.72 GB | [FLUX.2-klein-9B-GGUF (all quants)](https://huggingface.co/unsloth/FLUX.2-klein-9B-GGUF/tree/main) |
| `Flux-2-Klein-9B-KV-Q5_K_M.gguf` | 6.81 GB | same repo |
| `Flux-2-Klein-9B-KV-Q6_K.gguf` | 7.87 GB | same repo |
| `flux-2-klein-9b-Q4_K_M.gguf` (pc-client fallback) | 5.91 GB | same repo |
| `flux-2-klein-9b-Q5_K_M.gguf` | 7.02 GB | same repo |
| `flux-2-klein-9b-Q6_K.gguf` | 7.87 GB | same repo |

`flux-2-klein-9b-Q8_0.gguf` (~10 GB) also works, but the client's dropdown does
not list it — add it to `quantizationOptions` in
`client/src/components/Submit.svelte` if you want to select it from the UI.

**CLIP model** — `models/clip/`. The dropdown offers these three; the default is
the first.

| File | Size | Source |
|------|------|--------|
| `Qwen_Qwen3-8B-Q4_K_M.gguf` (**default**) | 5.03 GB | [bartowski/Qwen_Qwen3-8B-GGUF](https://huggingface.co/bartowski/Qwen_Qwen3-8B-GGUF/tree/main) |
| `Qwen3-8B-Q4_K_M.gguf` | 5.03 GB | [Aldaris/Qwen3-8B-Q4_K_M-GGUF](https://huggingface.co/Aldaris/Qwen3-8B-Q4_K_M-GGUF/blob/main/qwen3-8b-q4_k_m.gguf) — rename to this exact casing |
| `Qwen3-8B-Q4_K_M_v2.gguf` | 5.03 GB | any Qwen3-8B Q4_K_M build you want as a second slot |

**LoRA** — `models/loras/`. Optional: the workflow only wires node 181 in when the
job asks for a LoRA. The client's dropdown sends these two names, so whatever
adapters you want to offer must be saved under them (or you change the dropdown
and `ALLOWED_LORA` together).

| File | Dropdown label | Source |
|------|----------------|--------|
| `lora1.safetensors` | LoRa - N1 | any Flux 2 Klein LoRA you want in slot 1 |
| `lora2.safetensors` | LoRa - N2 | any Flux 2 Klein LoRA you want in slot 2 |

**VAE** — `models/vae/`

| File | Source |
|------|--------|
| `flux2-vae.safetensors` | [Flux 2 VAE](https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors) |

> **VRAM requirement:** Q4_K_M (~5.7–5.9 GB) runs comfortably on 12 GB VRAM.
> Larger quants need proportionally more: Q5_K_M ~7 GB, Q6_K ~7.9 GB, Q8_0 ~10 GB.
> Lower-VRAM systems may need to enable CPU offload in ComfyUI (`--cpu-offload`).

> **Only files the pc-client allows are accepted.** The allow-lists default to
> exactly the names above; if you add your own, list them in `ALLOWED_GGUF`,
> `ALLOWED_CLIP` or `ALLOWED_LORA` in `.env` as well as in the client dropdown.

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
| 164 | `ClipLoaderGGUF` | Loads the CLIP model (default `Qwen_Qwen3-8B-Q4_K_M.gguf`; selectable per job from the UI) |
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
