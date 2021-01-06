import { isWebSocketCloseEvent, WebSocket } from 'std/ws/mod.ts';
import { Application, Middleware, Request } from 'oak';
import { assert } from 'std/testing/asserts.ts';

// deno-lint-ignore no-explicit-any
export function nothrow(x: Promise<any>) {
    x.catch((e) => {
        console.error('failed nonthrow promise');
        console.error(e);
        Deno.exit(1);
    });
}
// deno-lint-ignore no-explicit-any
function nothrowf(x: () => Promise<any>) {
    nothrow(x());
}

export interface PublicRequest {
    path: string[];
    headers: Headers;
}

export interface IMessageHandlerOutput {
    close: (error?: number, reason?: string) => Promise<void>;
    sendMsg: (msg: string) => Promise<void>;
    ping: (data: string) => Promise<void>;
}
export interface IMessageHandler {
    resultType: 'message-handler';
    start(out: WebSocket): void;
    msg(msg: string): Promise<void>;
    closed(reason: number, message?: string): Promise<void>;
}

interface IWebsocketExtra {
    handler: IMessageHandler;
}

type Opaque<T> = { __opaque: T; resultType: undefined };

type RouteReturn<U> = U | IMessageHandler | Routes | null | undefined;
export type Route<T, U> = (
    body: T,
    request: PublicRequest,
) => RouteReturn<U> | Promise<RouteReturn<U>>;
export type RoutesTyped = {
    [route: string]: Route<Opaque<1>, Opaque<2>> | Opaque<3> | undefined;
};
export type Routes = { resultType: 'routes' };

function routesTyped(routes: Routes): RoutesTyped {
    // Anything may become routes type, actually.
    // Because routes typed indexing operation returns
    // undefined, an opaque value or a function.
    // We only presuppose that if the given attribute
    // is a function. Then it will be compatible with
    // the routing function.
    return (routes as unknown) as RoutesTyped;
}

export class OoServer implements Routes {
    public readonly resultType = 'routes';

    public setup(app: Application): void {
        // deno-lint-ignore no-explicit-any
        app.use(OoServer.middleware(this as any));
    }

    public static middleware(routes: Routes): Middleware {
        return async (ctx) => {
            try {
                if (ctx.request.headers.get('connection')) {
                    await ctx.upgrade();
                    // deno-lint-ignore no-explicit-any
                    (ctx.request.serverRequest as any).done.resolve(
                        new Error('force untrack'),
                    );
                }

                const r = await OoServer.route(
                    routes,
                    ctx.request,
                    this.prepareRequest(ctx.request),
                    ctx.socket,
                );
                if (r === null || r === undefined) {
                    // 404
                    assert(false);
                }

                const socket = ctx.socket;
                if (socket) {
                    assert(r.resultType === 'message-handler');
                    const handler = r as IMessageHandler;
                    nothrowf(async () => {
                        let clientClosed = false;
                        for await (const evt of socket) {
                            if (typeof evt === 'string') {
                                await handler.msg(evt);
                            } else if (isWebSocketCloseEvent(evt)) {
                                clientClosed = true;
                                await handler.closed(evt.code, evt.reason);
                            }
                        }

                        if (!clientClosed) {
                            await handler.closed(0);
                        }
                    });

                    handler.start(socket);
                    return;
                }

                ctx.response.status = 200;
                ctx.response.body = JSON.stringify(r);
                ctx.response.type = 'application/json';
            } catch (e) {
                console.error(e);
                // Error
                assert(false);
            }
        };
    }

    public static async route(
        routesArg: Routes,
        req: Request,
        pubReq: PublicRequest,
        socket: WebSocket | undefined,
    ): Promise<RouteReturn<Opaque<2>>> {
        const routes = routesTyped(routesArg);
        const method = socket ? 'ws' : req.method.toLowerCase();

        if (pubReq.path.length === 0) {
            pubReq.path = [''];
        }

        const route =
            OoServer.methodName(pubReq, routes, method) ||
            OoServer.methodName(pubReq, routes, 'any');

        if (!route) {
            return undefined;
        }

        pubReq.path.shift();
        const body = req.hasBody
            ? await req.body().value
            : this.query(req.url.searchParams);

        const result = await route(body, pubReq);

        if (result && result.resultType === 'routes') {
            return OoServer.route(result, req, pubReq, socket);
        } else {
            return result;
        }
    }

    public static prepareRequest(req: Request): PublicRequest {
        return {
            path: req.url.pathname
                .split('?', 1)[0]
                .split('/')
                .filter((x) => x.length > 0),
            headers: req.headers,
        };
    }

    private static query(search: URLSearchParams): Record<string, string> {
        const r: Record<string, string> = {};
        for (const each of search) {
            r[each[0]] = each[1];
        }
        return r;
    }

    private static methodName(
        req: PublicRequest,
        routes: RoutesTyped,
        method: string,
    ): Route<Opaque<1>, Opaque<2>> | undefined {
        const route = routes[`${method}_${req.path[0]}`];
        if (typeof route !== 'function') {
            return undefined;
        }

        return route.bind(routes);
    }
}
