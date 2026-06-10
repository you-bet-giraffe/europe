export interface MovementInput {
  forward:  number;   // -1 to 1  (W/S)
  right:    number;   // -1 to 1  (A/D)
  turn:     number;   // -1 to 1  (Q/E)
  sprint:   boolean;  // Shift
  flyUp:    boolean;  // X
  flyDown:  boolean;  // Z
}

const BINDINGS = {
  forward:   ["KeyW", "ArrowUp"],
  backward:  ["KeyS", "ArrowDown"],
  left:      ["KeyA", "ArrowLeft"],
  right:     ["KeyD", "ArrowRight"],
  turnLeft:  ["KeyQ"],
  turnRight: ["KeyE"],
  sprint:    ["ShiftLeft", "ShiftRight"],
  flyUp:     ["KeyX"],
  flyDown:   ["KeyZ"],
} as const;

export class InputController {
  private keys       = new Set<string>();
  private justPressed = new Set<string>(); // cleared after each consume()

  constructor() {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      this.justPressed.add(e.code);
    });
    window.addEventListener("keyup",  (e) => this.keys.delete(e.code));
    window.addEventListener("blur",   ()  => { this.keys.clear(); this.justPressed.clear(); });
  }

  // Returns true once per physical keypress; clears the record so the next
  // call returns false until the key is released and pressed again.
  consume(code: string): boolean {
    if (this.justPressed.has(code)) {
      this.justPressed.delete(code);
      return true;
    }
    return false;
  }

  get movement(): MovementInput {
    const fwd  = BINDINGS.forward.some(   c => this.keys.has(c));
    const back = BINDINGS.backward.some(  c => this.keys.has(c));
    const left = BINDINGS.left.some(      c => this.keys.has(c));
    const rgt  = BINDINGS.right.some(     c => this.keys.has(c));
    const tl   = BINDINGS.turnLeft.some(  c => this.keys.has(c));
    const tr   = BINDINGS.turnRight.some( c => this.keys.has(c));
    return {
      forward: (fwd ? 1 : 0) - (back ? 1 : 0),
      right:   (rgt ? 1 : 0) - (left ? 1 : 0),
      turn:    (tr  ? 1 : 0) - (tl   ? 1 : 0),
      sprint:  BINDINGS.sprint.some(c => this.keys.has(c)),
      flyUp:   BINDINGS.flyUp.some( c => this.keys.has(c)),
      flyDown: BINDINGS.flyDown.some(c => this.keys.has(c)),
    };
  }

  dispose(): void {
    window.removeEventListener("keydown", (e) => this.keys.add(e.code));
    window.removeEventListener("keyup",   (e) => this.keys.delete(e.code));
    window.removeEventListener("blur",    ()  => this.keys.clear());
  }
}
