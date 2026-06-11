import { AbstractEngine, Engine, WebGPUEngine } from "@babylonjs/core";
import { Game } from "./game";
import { TEST_MODE } from "./testMode";

async function createEngine(canvas: HTMLCanvasElement): Promise<AbstractEngine> {
  // Tests force WebGL2 for reproducibility; otherwise prefer WebGPU.
  if (!TEST_MODE && await WebGPUEngine.IsSupportedAsync) {
    const engine = new WebGPUEngine(canvas, {
      antialias: true,
      adaptToDeviceRatio: true,
    });
    await engine.initAsync();
    console.log("Using WebGPU");
    return engine;
  }

  console.log(TEST_MODE ? "Using WebGL2 (test mode)" : "WebGPU not supported, falling back to WebGL2");
  return new Engine(canvas, true, { adaptToDeviceRatio: true });
}

async function main() {
  const canvas = document.getElementById("render-canvas") as HTMLCanvasElement;
  if (!canvas) throw new Error("Canvas not found");

  const engine = await createEngine(canvas);
  const game = new Game(engine, canvas);
  await game.init();

  engine.runRenderLoop(() => game.update());
  window.addEventListener("resize", () => engine.resize());
}

main().catch((err) => {
  console.error(err);
  // Surface init errors visibly on screen
  const div = document.createElement("div");
  div.style.cssText = "position:fixed;top:10px;left:10px;color:red;font:14px monospace;z-index:9999;white-space:pre";
  div.textContent = String(err);
  document.body.appendChild(div);
});
