import type { ClientMessage, PlayerState, ServerMessage } from "../../shared/types";

export class NetworkClient {
  onInit?:         (id: string) => void;
  onWorldState?:   (players: PlayerState[]) => void;
  onPlayerJoined?: (player: PlayerState) => void;
  onPlayerLeft?:   (id: string) => void;

  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;

  constructor(private url: string) {}

  connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener("open", () => {
      console.log("Connected to server");
      this.reconnectDelay = 1000;
    });

    this.ws.addEventListener("message", (event) => {
      const msg: ServerMessage = JSON.parse(event.data as string);
      this.handleMessage(msg);
    });

    this.ws.addEventListener("close", () => {
      console.log(`Disconnected, reconnecting in ${this.reconnectDelay}ms`);
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    });

    this.ws.addEventListener("error", (err) => {
      console.error("WebSocket error", err);
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "init":
        this.onInit?.(msg.id);
        break;
      case "world_state":
        this.onWorldState?.(msg.players);
        break;
      case "player_joined":
        this.onPlayerJoined?.(msg.player);
        break;
      case "player_left":
        this.onPlayerLeft?.(msg.id);
        break;
    }
  }
}
