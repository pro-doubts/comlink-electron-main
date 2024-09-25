
export type Sendable = boolean | Date | RegExp | string | undefined | number | BigInt | Sendable[] | Set<Sendable> | Map<Sendable, Sendable> | ArrayBuffer | DataView | Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array | BigInt64Array | BigUint64Array | { [key: string]: Sendable; };

export const enum WireValueType {
  RAW = "RAW",
  PROXY = "PROXY",
  THROW = "THROW",
  HANDLER = "HANDLER",
}

export type RawWireValue = {
  id?: string;
  type: WireValueType.RAW;
  value: Sendable;
};

export type HandlerWireValue = {
  id?: string;
  type: WireValueType.HANDLER;
  name: string;
  value: Sendable;
};

export type WireValue = RawWireValue | HandlerWireValue;

export type MessageID = string;

export const enum MessageType {
  GET = "GET",
  SET = "SET",
  APPLY = "APPLY",
  CONSTRUCT = "CONSTRUCT",
  RELEASE = "RELEASE",
};

export type Argument = {
  value: WireValue;
  portCount: number;
};

export type GetMessage = {
  id?: MessageID;
  type: MessageType.GET;
  path: string[];
};

export type SetMessage = {
  id?: MessageID;
  type: MessageType.SET;
  path: string[];
  value: WireValue;
};

export type ApplyMessage = {
  id?: MessageID;
  type: MessageType.APPLY;
  path: string[];
  argumentList: Argument[];
};

export type ConstructMessage = {
  id?: MessageID;
  type: MessageType.CONSTRUCT;
  path: string[];
  argumentList: Argument[];
};

export type ReleaseMessage = {
  id?: MessageID;
  type: MessageType.RELEASE;
};

export type Message =
  | GetMessage
  | SetMessage
  | ApplyMessage
  | ConstructMessage
  | ReleaseMessage;