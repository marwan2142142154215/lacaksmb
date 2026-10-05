import { useCallback, useEffect, useRef, useState } from "react";

const BROKER_URL = import.meta.env.VITE_BROKER_URL || "wss://192.168.100.118:8787/ws";

export type PilotTelemetry = {
  deviceId: string;
  masterId: string;
  detected: boolean;
  rssi: number | null;
  receivedAt: string | null;
  online: boolean;
  deviceOwner?: boolean;
  lockTaskMode?: number;
  batteryLevel?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  locationAt?: string | null;
  locationProvider?: string | null;
};

export type BrokerCommand = {
  type: "command";
  commandId: string;
  targetId: string;
  command: "lock" | "unlock";
};

type BrokerRole = "master" | "tracker";
type BrokerPacket = Record<string, unknown> & { type?: string };

export function usePilotBroker(
  role: BrokerRole,
  deviceId: string,
  onCommand?: (command: BrokerCommand) => Promise<{ ok: boolean; detail?: string }>,
) {
  const socket = useRef<WebSocket | null>(null);
  const retryTimer = useRef<number | undefined>(undefined);
  const commandHandler = useRef(onCommand);
  const [connected, setConnected] = useState(false);
  const [telemetry, setTelemetry] = useState<PilotTelemetry | null>(null);
  const [devices, setDevices] = useState<Array<{ deviceId: string; name: string; role?: string; online: boolean; lastSeenAt?: string | null; telemetry?: PilotTelemetry | null }>>([]);
  const [commandUpdates, setCommandUpdates] = useState<BrokerPacket[]>([]);

  commandHandler.current = onCommand;

  useEffect(() => {
    let disposed = false;
    const token = import.meta.env.VITE_DEVICE_TOKEN;
    if (!token) {
      setConnected(false);
      return;
    }

    const connect = () => {
      if (disposed) return;
      const url = new URL(BROKER_URL);
      url.searchParams.set("deviceId", deviceId);
      url.searchParams.set("token", token);
      const current = new WebSocket(url);
      socket.current = current;
      current.onopen = () => { if (!disposed) setConnected(true); };
      current.onmessage = (event) => {
        if (disposed) return;
        try {
          const packet = JSON.parse(String(event.data)) as BrokerPacket;
          if (packet.type === "telemetry") setTelemetry(packet as PilotTelemetry);
          if (packet.type === "devices" && Array.isArray(packet.devices)) setDevices(packet.devices as typeof devices);
          if (packet.type === "command" && role === "tracker") {
            const command = packet as unknown as BrokerCommand;
            void commandHandler.current?.(command).then((result) => {
              if (current.readyState === WebSocket.OPEN) {
                current.send(JSON.stringify({ type: "commandAck", commandId: command.commandId, ...result }));
              }
            }).catch((error: unknown) => {
              if (current.readyState === WebSocket.OPEN) {
                current.send(JSON.stringify({ type: "commandAck", commandId: command.commandId, ok: false, detail: error instanceof Error ? error.message : "Command failed." }));
              }
            });
          }
          if (packet.type === "commandQueued" || packet.type === "commandUpdate" || packet.type === "commandResult") {
            setCommandUpdates((currentUpdates) => [packet, ...currentUpdates].slice(0, 20));
          }
        } catch {
          // Ignore malformed broker packets.
        }
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (disposed) return;
        setConnected(false);
        retryTimer.current = window.setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer.current !== undefined) window.clearTimeout(retryTimer.current);
      socket.current?.close();
      socket.current = null;
    };
  }, [deviceId, role]);

  const send = useCallback((message: Record<string, unknown>) => {
    const current = socket.current;
    if (current?.readyState === WebSocket.OPEN) current.send(JSON.stringify(message));
  }, []);

  return { connected, telemetry, devices, commandUpdates, send };
}
