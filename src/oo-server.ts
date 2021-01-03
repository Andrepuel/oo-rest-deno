import { isWebSocketCloseEvent, WebSocket } from 'std/ws/mod.ts';
import { Application, Request } from 'oak';
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

export interface IRequest {
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

export class OoServer {
    public setup(app: Application): void {
        app.use(async (ctx) => {
            try {
                if (ctx.request.headers.get('connection')) {
                    await ctx.upgrade();
                    // deno-lint-ignore no-explicit-any
                    (ctx.request.serverRequest as any).done.resolve(
                        new Error('force untrack'),
                    );
                }

                const r = await this.findRoute(
                    ctx.request,
                    ctx.socket,
                    ctx.request.url.pathname,
                );
                if (r === null) {
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
        });
    }

    public async findRoute(
        req: Request,
        socket: WebSocket | undefined,
        urlStr: string,
        // deno-lint-ignore no-explicit-any
    ): Promise<any | null> {
        const reqSimple: IRequest = {
            path: urlStr
                .split('?', 1)[0]
                .split('/')
                .filter((x) => x.length > 0),
            headers: req.headers,
        };

        const method = socket ? 'ws' : req.method.toLowerCase();

        if (reqSimple.path.length === 0) {
            reqSimple.path = [''];
        }

        // deno-lint-ignore no-explicit-any
        const router = this as any;

        const route =
            router[method + '_' + reqSimple.path[0]] ||
            router['any_' + reqSimple.path[0]];
        if (route) {
            reqSimple.path.shift();
            const body = req.hasBody
                ? await req.body().value
                : this.query(req.url.searchParams);
            const x = await Promise.resolve().then(() =>
                route.apply(this, [body, reqSimple]),
            );

            if (x instanceof OoServer) {
                const urlStr2 = '/' + reqSimple.path.join('/');
                return x.findRoute(req, socket, urlStr2);
            }

            return x;
        } else {
            return null;
        }
    }

    private query(search: URLSearchParams): Record<string, string> {
        const r: Record<string, string> = {};
        for (const each of search) {
            r[each[0]] = each[1];
        }
        return r;
    }
}
