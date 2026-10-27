import type { LocalModelPackId } from "@axle/contracts";

/**
 * The downloadable side of an Axle Offline pack. Metadata shared with the
 * renderer lives in `@axle/contracts`; model URLs and hashes stay server-side
 * so the renderer never becomes a download client with its own trust story.
 */
export interface LocalModelFileDefinition {
  readonly fileName: string;
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface LocalModelPackDefinition {
  readonly id: LocalModelPackId;
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly quantization: string;
  readonly minRamGb: number;
  readonly contextWindowTokens: number;
  readonly license: string;
  readonly sourceUrl: string;
  readonly files: ReadonlyArray<LocalModelFileDefinition>;
  /** The GGUF passed to llama-server as `--model`. */
  readonly primaryFileName: string;
  /** The multimodal projector passed as `--mmproj`. */
  readonly mmprojFileName?: string;
}

const huggingFaceUrl = (repository: string, fileName: string): string =>
  `https://huggingface.co/${repository}/resolve/main/${encodeURIComponent(fileName)}`;

const file = (
  repository: string,
  fileName: string,
  sizeBytes: number,
  sha256: string,
): LocalModelFileDefinition => ({
  fileName,
  url: huggingFaceUrl(repository, fileName),
  sizeBytes,
  sha256,
});

const QWEN3_4B = "Qwen/Qwen3-4B-GGUF";
const QWEN3_8B = "Qwen/Qwen3-8B-GGUF";
const GPT_OSS_20B = "ggml-org/gpt-oss-20b-GGUF";
const QWEN3_30B = "Qwen/Qwen3-30B-A3B-GGUF";
const QWEN25_CODER_14B = "Qwen/Qwen2.5-Coder-14B-Instruct-GGUF";
const QWEN25_VL_7B = "unsloth/Qwen2.5-VL-7B-Instruct-GGUF";

export const LOCAL_MODEL_PACKS: ReadonlyArray<LocalModelPackDefinition> = [
  {
    id: "compact",
    name: "Compact",
    description: "Fast everyday chat and small edits on almost any laptop.",
    model: "Qwen3 4B",
    quantization: "Q4_K_M",
    minRamGb: 8,
    contextWindowTokens: 32_768,
    license: "Apache-2.0",
    sourceUrl: "https://huggingface.co/Qwen/Qwen3-4B-GGUF",
    primaryFileName: "Qwen3-4B-Q4_K_M.gguf",
    files: [
      file(
        QWEN3_4B,
        "Qwen3-4B-Q4_K_M.gguf",
        2_497_280_256,
        "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
      ),
    ],
  },
  {
    id: "standard",
    name: "Standard",
    description: "The default balance of quality and speed for coding sessions.",
    model: "Qwen3 8B",
    quantization: "Q4_K_M",
    minRamGb: 12,
    contextWindowTokens: 32_768,
    license: "Apache-2.0",
    sourceUrl: "https://huggingface.co/Qwen/Qwen3-8B-GGUF",
    primaryFileName: "Qwen3-8B-Q4_K_M.gguf",
    files: [
      file(
        QWEN3_8B,
        "Qwen3-8B-Q4_K_M.gguf",
        5_027_783_488,
        "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",
      ),
    ],
  },
  {
    id: "advanced",
    name: "Advanced",
    description: "OpenAI's gpt-oss 20B with strong reasoning for larger codebases.",
    model: "gpt-oss 20B",
    quantization: "MXFP4",
    minRamGb: 24,
    contextWindowTokens: 32_768,
    license: "Apache-2.0",
    sourceUrl: "https://huggingface.co/ggml-org/gpt-oss-20b-GGUF",
    primaryFileName: "gpt-oss-20b-MXFP4.gguf",
    files: [
      file(
        GPT_OSS_20B,
        "gpt-oss-20b-MXFP4.gguf",
        12_109_566_624,
        "27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901",
      ),
    ],
  },
  {
    id: "max",
    name: "Max",
    description: "Qwen3 30B-A3B mixture-of-experts, the strongest local reasoner.",
    model: "Qwen3 30B-A3B",
    quantization: "Q4_K_M",
    minRamGb: 32,
    contextWindowTokens: 32_768,
    license: "Apache-2.0",
    sourceUrl: "https://huggingface.co/Qwen/Qwen3-30B-A3B-GGUF",
    primaryFileName: "Qwen3-30B-A3B-Q4_K_M.gguf",
    files: [
      file(
        QWEN3_30B,
        "Qwen3-30B-A3B-Q4_K_M.gguf",
        18_556_685_824,
        "0d003f6662faee786ed5da3e31b29c978de5ae5d275c8794c606a7f3c01aa8f5",
      ),
    ],
  },
  {
    id: "coder",
    name: "Coder",
    description: "Qwen2.5-Coder 14B tuned for refactors, tests, and repositories.",
    model: "Qwen2.5-Coder 14B",
    quantization: "Q4_K_M",
    minRamGb: 16,
    contextWindowTokens: 32_768,
    license: "Apache-2.0",
    sourceUrl: "https://huggingface.co/Qwen/Qwen2.5-Coder-14B-Instruct-GGUF",
    primaryFileName: "qwen2.5-coder-14b-instruct-q4_k_m.gguf",
    files: [
      file(
        QWEN25_CODER_14B,
        "qwen2.5-coder-14b-instruct-q4_k_m.gguf",
        8_988_110_272,
        "c1e659736d89ac1065fb495330fb824d94001974a4bfa78e7270e43476a8d940",
      ),
    ],
  },
  {
    id: "vision",
    name: "Vision",
    description: "Qwen2.5-VL 7B for screenshots, diagrams, and visual review.",
    model: "Qwen2.5-VL 7B",
    quantization: "Q4_K_M",
    minRamGb: 16,
    contextWindowTokens: 32_768,
    license: "Apache-2.0",
    sourceUrl: "https://huggingface.co/unsloth/Qwen2.5-VL-7B-Instruct-GGUF",
    primaryFileName: "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf",
    mmprojFileName: "mmproj-F16.gguf",
    files: [
      file(
        QWEN25_VL_7B,
        "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf",
        4_683_072_384,
        "d16776dcd9a28d42758c2958ed3a752aabf20a305252cd64ff2be72b4a78c503",
      ),
      file(
        QWEN25_VL_7B,
        "mmproj-F16.gguf",
        1_354_163_040,
        "987dd0733033fb5dd9b124d1ca926ae865572e432384eee7618b2eec3e735e17",
      ),
    ],
  },
];

export const localModelPack = (id: LocalModelPackId): LocalModelPackDefinition | undefined =>
  LOCAL_MODEL_PACKS.find((pack) => pack.id === id);

export const localModelPackSize = (pack: LocalModelPackDefinition): number =>
  pack.files.reduce((total, entry) => total + entry.sizeBytes, 0);
