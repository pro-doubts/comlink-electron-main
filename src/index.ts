import { MessageChannelMain, MessageEvent, MessagePortMain } from "electron";
import {
  Argument,
  Message,
  MessageType,
  Sendable,
  WireValue,
  WireValueType
} from "./protocol";

export const proxyMarker = Symbol("Comlink.proxy");
export const createEndpoint = Symbol("Comlink.endpoint");
export const releaseProxy = Symbol("Comlink.releaseProxy");

const throwMarker = Symbol("Comlink.thrown");
type UnknownObject = { [key: string | symbol | number]: unknown; };
type Constructor = new (...args: unknown[]) => UnknownObject;

/**
 * Interface of values that were marked to be proxied with `comlink.proxy()`.
 * Can also be implemented by classes.
 */
export type ProxyMarked = {
  [proxyMarker]: true;
};

/**
 * Takes a type and wraps it in a Promise, if it not already is one.
 * This is to avoid `Promise<Promise<T>>`.
 *
 * This is the inverse of `Unpromisify<T>`.
 */
type Promisify<T> = T extends Promise<unknown> ? T : Promise<T>;
/**
 * Takes a type that may be Promise and unwraps the Promise type.
 * If `P` is not a Promise, it returns `P`.
 *
 * This is the inverse of `Promisify<T>`.
 */
type Unpromisify<P> = P extends Promise<infer T> ? T : P;

/**
 * Takes the raw type of a remote property and returns the type that is visible to the local thread on the proxy.
 *
 * Note: This needs to be its own type alias, otherwise it will not distribute over unions.
 * See https://www.typescriptlang.org/docs/handbook/advanced-types.html#distributive-conditional-types
 */
type RemoteProperty<T> =
  // If the value is a method, comlink will proxy it automatically.
  // Objects are only proxied if they are marked to be proxied.
  // Otherwise, the property is converted to a Promise that resolves the cloned value.
  T extends Function | ProxyMarked ? Remote<T> : Promisify<T>;

/**
 * Takes the raw type of a property as a remote thread would see it through a proxy (e.g. when passed in as a function
 * argument) and returns the type that the local thread has to supply.
 *
 * This is the inverse of `RemoteProperty<T>`.
 *
 * Note: This needs to be its own type alias, otherwise it will not distribute over unions. See
 * https://www.typescriptlang.org/docs/handbook/advanced-types.html#distributive-conditional-types
 */
type LocalProperty<T> = T extends Function | ProxyMarked
  ? Local<T>
  : Unpromisify<T>;

/**
 * Proxies `T` if it is a `ProxyMarked`, clones it otherwise (as handled by structured cloning and transfer handlers).
 */
export type ProxyOrClone<T> = T extends ProxyMarked ? Remote<T> : T;
/**
 * Inverse of `ProxyOrClone<T>`.
 */
export type UnproxyOrClone<T> = T extends RemoteObject<ProxyMarked>
  ? Local<T>
  : T;

/**
 * Takes the raw type of a remote object in the other thread and returns the type as it is visible to the local thread
 * when proxied with `Comlink.proxy()`.
 *
 * This does not handle call signatures, which is handled by the more general `Remote<T>` type.
 *
 * @template T The raw type of a remote object as seen in the other thread.
 */
export type RemoteObject<T> = { [P in keyof T]: RemoteProperty<T[P]> };
/**
 * Takes the type of an object as a remote thread would see it through a proxy (e.g. when passed in as a function
 * argument) and returns the type that the local thread has to supply.
 *
 * This does not handle call signatures, which is handled by the more general `Local<T>` type.
 *
 * This is the inverse of `RemoteObject<T>`.
 *
 * @template T The type of a proxied object.
 */
export type LocalObject<T> = { [P in keyof T]: LocalProperty<T[P]> };

/**
 * Additional special comlink methods available on each proxy returned by `Comlink.wrap()`.
 */
export interface ProxyMethods {
  [createEndpoint]: () => Promise<MessagePortMain>;
  [releaseProxy]: () => void;
}

/**
 * Takes the raw type of a remote object, function or class in the other thread and returns the type as it is visible to
 * the local thread from the proxy return value of `Comlink.wrap()` or `Comlink.proxy()`.
 */
export type Remote<T> =
  // Handle properties
  RemoteObject<T> &
  // Handle call signature (if present)
  (T extends (...args: infer TArguments) => infer TReturn
    ? (
      ...args: { [I in keyof TArguments]: UnproxyOrClone<TArguments[I]> }
    ) => Promisify<ProxyOrClone<Unpromisify<TReturn>>>
    : unknown) &
  // Handle construct signature (if present)
  // The return of construct signatures is always proxied (whether marked or not)
  (T extends { new(...args: infer TArguments): infer TInstance; }
    ? {
      new(
        ...args: {
          [I in keyof TArguments]: UnproxyOrClone<TArguments[I]>;
        }
      ): Promisify<Remote<TInstance>>;
    }
    : unknown) &
  // Include additional special comlink methods available on the proxy.
  ProxyMethods;

/**
 * Expresses that a type can be either a sync or async.
 */
type MaybePromise<T> = Promise<T> | T;

/**
 * Takes the raw type of a remote object, function or class as a remote thread would see it through a proxy (e.g. when
 * passed in as a function argument) and returns the type the local thread has to supply.
 *
 * This is the inverse of `Remote<T>`. It takes a `Remote<T>` and returns its original input `T`.
 */
export type Local<T> =
  // Omit the special proxy methods (they don't need to be supplied, comlink adds them)
  Omit<LocalObject<T>, keyof ProxyMethods> &
  // Handle call signatures (if present)
  (T extends (...args: infer TArguments) => infer TReturn
    ? (
      ...args: { [I in keyof TArguments]: ProxyOrClone<TArguments[I]> }
    ) => // The raw function could either be sync or async, but is always proxied automatically
      MaybePromise<UnproxyOrClone<Unpromisify<TReturn>>>
    : unknown) &
  // Handle construct signature (if present)
  // The return of construct signatures is always proxied (whether marked or not)
  (T extends { new(...args: infer TArguments): infer TInstance; }
    ? {
      new(
        ...args: {
          [I in keyof TArguments]: ProxyOrClone<TArguments[I]>;
        }
      ): // The raw constructor could either be sync or async, but is always proxied automatically
        MaybePromise<Local<Unpromisify<TInstance>>>;
    }
    : unknown);

const isObject = (val: unknown): val is object =>
  (typeof val === "object" && val !== null) || typeof val === "function";

/**
 * Customizes the serialization of certain values as determined by `canHandle()`.
 *
 * @template T The input type being handled by this transfer handler.
 * @template S The serialized type sent over the wire.
 */
export interface TransferHandler<T, S extends Sendable> {
  /**
   * Gets called for every value to determine whether this transfer handler
   * should serialize the value, which includes checking that it is of the right
   * type (but can perform checks beyond that as well).
   */
  canHandle(value: unknown): value is T;

  /**
   * Gets called with the value if `canHandle()` returned `true` to produce a
   * value that can be sent in a message, consisting of structured-cloneable
   * values and/or transferrable objects.
   */
  serialize(value: T): [S, MessagePortMain[]];

  /**
   * Gets called to deserialize an incoming value that was serialized in the
   * other thread with this transfer handler (known through the name it was
   * registered under).
   */
  deserialize(value: S, ports: MessagePortMain[]): T;
}

/**
 * Internal transfer handle to handle objects marked to proxy.
 */
const proxyTransferHandler: TransferHandler<object, 0> = {
  canHandle: (val): val is ProxyMarked =>
    isObject(val) && (val as ProxyMarked)[proxyMarker],
  serialize(obj) {
    const { port1, port2 } = new MessageChannelMain();
    expose(obj, port1);
    return [0, [port2]];
  },
  deserialize(_value, ports) {
    let port = ports[0];
    if (!port) throw new Error("Did not receive a MessagePort!");
    port.start();
    return wrap(port);
  },
};

interface ThrownValue {
  [throwMarker]: unknown; // just needs to be present
  value: Sendable;
}
type SerializedThrownValue =
  | { isError: true; value: { message: string, name: string, stack?: string; }; }
  | { isError: false; value: Sendable; };

/**
 * Internal transfer handler to handle thrown exceptions.
 */
const throwTransferHandler: TransferHandler<
  ThrownValue,
  SerializedThrownValue
> = {
  canHandle: (value): value is ThrownValue =>
    isObject(value) && throwMarker in value,
  serialize({ value }) {
    let serialized: SerializedThrownValue;
    if (value instanceof Error) {
      serialized = {
        isError: true,
        value: {
          message: value.message,
          name: value.name,
          ...(value.stack && { stack: value.stack }),
        },
      };
    } else {
      serialized = { isError: false, value };
    }
    return [serialized, []];
  },
  deserialize(serialized) {
    if (serialized.isError) {
      throw Object.assign(
        new Error(serialized.value.message),
        serialized.value
      );
    }
    throw serialized.value;
  },
};

/**
 * Allows customizing the serialization of certain values.
 */
export const transferHandlers = new Map<
  string,
  TransferHandler<unknown, Sendable>
>([
  ["proxy", proxyTransferHandler],
  ["throw", throwTransferHandler],
]);

export function expose(obj: unknown, ep: MessagePortMain) {
  ep.on("message", function callback(ev: MessageEvent) {
    try {
      if (!ev || !ev.data) {
        return;
      }
      const { id, type, path } = {
        path: [] as string[],
        ...(ev.data as Message),
      };
      let ports = [...ev.ports];
      let argumentList: unknown[] = [];
      for (let argument of (ev.data.argumentList || [])) {
        argumentList.push(fromWireValue([argument.value, ports.splice(0, argument.portCount)]));
      }
      let returnValue;
      try {
        let parentPath = path.slice(0, -1);
        const parent = parentPath.reduce((obj, prop) => {
          if (typeof obj === "object" && obj !== null) {
            return (<{ [key: string | number | symbol]: unknown; }>obj)[prop];
          }
          return undefined;
        }, obj);
        const rawValue = path.reduce((obj, prop) => {
          if (typeof obj === "object" && obj !== null) {
            return (<UnknownObject>obj)[prop];
          }
          return undefined;
        }, obj);
        switch (type) {
          case MessageType.GET:
            {
              returnValue = rawValue;
            }
            break;
          case MessageType.SET:
            {
              let field = path.at(-1);
              if (field === undefined) throw new Error("Only assignment of properties is allowed!");
              if (typeof parent !== "object" && parent === null) throw new Error("Only assignment to Objects (!== null) are allowed!");
              (<UnknownObject>parent)[field] = fromWireValue([ev.data.value, ports]);
              returnValue = true;
            }
            break;
          case MessageType.APPLY:
            {
              if (typeof rawValue !== "function") throw new Error("Only calls to functions are allowed!");
              returnValue = rawValue.apply(parent, argumentList);
            }
            break;
          case MessageType.CONSTRUCT:
            {
              if (typeof rawValue !== "function") throw new Error("Only calls to functions are allowed!");
              const value = new (<Constructor>rawValue)(...argumentList);
              returnValue = proxy(value);
            }
            break;
          case MessageType.RELEASE:
            {
              returnValue = undefined;
            }
            break;
          default:
            return;
        }
      } catch (value) {
        returnValue = { value, [throwMarker]: 0 };
      }
      Promise.resolve(returnValue)
        .catch((value) => {
          return { value, [throwMarker]: 0 };
        })
        .then((returnValue) => {
          const [wireValue, transferables] = toWireValue(returnValue);
          let message: Sendable = { ...wireValue, id };
          ep.postMessage(message, transferables);
          if (type === MessageType.RELEASE) {
            // detach and deactive after sending release response above.
            ep.off("message", callback);
            ep.close();
          }
        });
    } catch (e) {
      console.log(e);
    }
  });
  ep.start();
}

export function wrap<T>(ep: MessagePortMain): Remote<T> {
  return createProxy<T>(ep, []);
}

function throwIfProxyReleased(isReleased: boolean) {
  if (isReleased) {
    throw new Error("Proxy has been released and is not useable");
  }
}

// Global Variables for automatically closing Endpoints
const finReg = new FinalizationRegistry(finalize);
const finRegCount: Map<MessagePortMain, { value: number; }> = new Map();

// is called each time a Proxy is Garbage Collected
function finalize(ep: MessagePortMain) {
  let count = finRegCount.get(ep);
  if (count === undefined) return;
  count.value--;
  if (count.value > 0) return;
  finRegCount.delete(ep);
  requestResponseMessage(ep, { type: MessageType.RELEASE }).catch(console.error);
  setTimeout(() => {
    ep.close();
  }, 100);
}

// create and increment Reference counter and register Garbage collection Callback
function registerProxy(proxy: object, ep: MessagePortMain): void {
  let count = finRegCount.get(ep);
  if (count === undefined) {
    count = { value: 0 };
    finRegCount.set(ep, count);
  }
  count.value++;
  finReg.register(proxy, ep);
}

function createProxy<T>(
  ep: MessagePortMain,
  path: (string | number | symbol)[] = []
): Remote<T> {
  let isProxyReleased = false;
  const proxy = new Proxy(function () { }, {
    get(_target, prop) {
      throwIfProxyReleased(isProxyReleased);
      if (prop === releaseProxy) {
        return () => {
          return requestResponseMessage(ep, {
            type: MessageType.RELEASE,
          }).then(() => {
            ep.close();
            isProxyReleased = true;
          });
        };
      }
      if (prop === "then") {
        if (path.length === 0) {
          return { then: () => proxy };
        }
        const r = requestResponseMessage(ep, {
          type: MessageType.GET,
          path: path.map((p) => p.toString()),
        }).then(fromWireValue);
        return r.then.bind(r);
      }
      return createProxy(ep, [...path, prop]);
    },
    set(_target, prop, rawValue) {
      throwIfProxyReleased(isProxyReleased);
      const [value, transferables] = toWireValue(rawValue);
      requestResponseMessage(
        ep,
        {
          type: MessageType.SET,
          path: [...path, prop].map((p) => p.toString()),
          value,
        },
        transferables
      ).then(fromWireValue);
      // ToDo: Set can not be implemented as a assignment reliably, so create an alternative set Method
      return true;
    },
    apply(_target, _thisArg, rawArgumentList) {
      throwIfProxyReleased(isProxyReleased);
      const last = path[path.length - 1];
      // We just pretend that `bind()` didn’t happen.
      if (last === "bind") {
        return createProxy(ep, path.slice(0, -1));
      }
      const [argumentList, transferables] = processArguments(rawArgumentList);
      return requestResponseMessage(
        ep,
        {
          type: MessageType.APPLY,
          path: path.map((p) => p.toString()),
          argumentList,
        },
        transferables
      ).then(fromWireValue);
    },
    construct(_target, rawArgumentList) {
      throwIfProxyReleased(isProxyReleased);
      const [argumentList, transferables] = processArguments(rawArgumentList);
      return requestResponseMessage(
        ep,
        {
          type: MessageType.CONSTRUCT,
          path: path.map((p) => p.toString()),
          argumentList,
        },
        transferables
      ).then(fromWireValue);
    },
  });
  registerProxy(proxy, ep);
  return <Remote<T>>proxy;
}

export const MessagePortMainCtor = new MessageChannelMain().port1.constructor;

export function isMessagePort(endpoint: unknown): endpoint is MessagePortMain {
  return endpoint instanceof MessagePortMainCtor;
}

function myFlat<T>(arr: (T | T[])[]): T[] {
  return Array.prototype.concat.apply([], arr);
}

function processArguments(argumentList: unknown[]): [Argument[], MessagePortMain[]] {
  const processed = argumentList.map(toWireValue);
  return [processed.map((v) => ({ value: v[0], portCount: v[1].length })), myFlat(processed.map((v) => v[1]))];
}

export function proxy<T extends {}>(obj: T): T & ProxyMarked {
  return Object.assign(obj, { [proxyMarker]: true } as const);
}

function toWireValue(value: unknown): [WireValue, MessagePortMain[]] {
  for (const [name, handler] of transferHandlers) {
    if (handler.canHandle(value)) {
      const [serializedValue, transferables] = handler.serialize(value);
      return [
        {
          type: WireValueType.HANDLER,
          name,
          value: serializedValue,
        },
        transferables,
      ];
    }
  }
  return [{ type: WireValueType.RAW, value: <Sendable>value }, []];
}

function fromWireValue([value, ports]: [WireValue, MessagePortMain[]]): unknown {
  switch (value.type) {
    case WireValueType.HANDLER:
      return transferHandlers.get(value.name)!.deserialize(value.value, ports);
    case WireValueType.RAW:
      return value.value;
  }
}

function requestResponseMessage(
  ep: MessagePortMain,
  msg: Message,
  transfers: MessagePortMain[] = []
): Promise<[WireValue, MessagePortMain[]]> {
  return new Promise((resolve) => {
    const id = generateUUID();
    ep.on("message", function l(ev: MessageEvent) {
      try {
        if (!ev.data || !ev.data.id || ev.data.id !== id) {
          return;
        }
        ep.off("message", l);
        resolve([ev.data, ev.ports]);
      } catch (e) {
        console.log(e);
      }
    });
    if (ep.start) {
      ep.start();
    }
    let message: Sendable = { id, ...msg };
    ep.postMessage(message, transfers);
  });
}

function generateUUID(): string {
  return new Array(4)
    .fill(0)
    .map(() => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16))
    .join("-");
}