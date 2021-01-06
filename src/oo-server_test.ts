// deno-lint-ignore-file
import { assert, assertEquals } from 'std/testing/asserts.ts';
import {
    IMessageHandler,
    OoServer,
    nothrow,
    PublicRequest,
} from './oo-server.ts';
import { Application, send } from 'oak';
import { suite } from 'testtree';

function tick(): Promise<void> {
    return new Promise((ok) => setTimeout(ok, 10));
}

class Requester {
    constructor(private readonly port: number) {}

    public async request(
        path: string,
        method: 'GET' | 'PUT' = 'GET',
        sendBody: any | undefined = undefined,
    ): Promise<{ response: Response; body: any }> {
        const response = await fetch(`http://127.0.0.1:${this.port}/${path}`, {
            method,
            headers: {
                'content-type': 'application/json',
            },
            body: sendBody ? JSON.stringify(sendBody) : undefined,
        });

        const encoder = new TextDecoder('utf8');
        const blob = await response.blob();
        const text = encoder.decode(await blob.arrayBuffer());

        try {
            assertEquals(response.status, 200);
            assertEquals(
                response.headers.get('content-type'),
                'application/json; charset=utf-8',
            );
            const body = JSON.parse(text);

            return {
                response,
                body,
            };
        } catch (e) {
            throw new Error("Can't parse JSON " + JSON.stringify([text]));
        }
    }

    public connect(path: string): Promise<WebSocket> {
        const client = new WebSocket(`ws://127.0.0.1:${this.port}/${path}`);
        const conn = new Promise<WebSocket>((ok, err) => {
            client.onopen = () => ok(client);
            client.onerror = (e) => err(e);
        });
        return conn;
    }
}

class TestSubPath extends OoServer {
    public async get_(): Promise<string> {
        await Promise.resolve();
        return 'sub';
    }
}

interface IPingPong {
    ping: string;
    pong: string;
}

class TestServer extends OoServer {
    public handler: IMessageHandler = null!;

    constructor() {
        super();
    }

    public async get_(): Promise<string> {
        await Promise.resolve();
        return 'Hello World!';
    }

    public async get_asd(): Promise<string> {
        await Promise.resolve();
        return 'world';
    }

    public async get_sub() {
        await Promise.resolve();
        return new TestSubPath();
    }

    public async ws_listen(): Promise<IMessageHandler> {
        await Promise.resolve();
        return this.handler;
    }

    public async any_echo(obj: IPingPong): Promise<IPingPong> {
        await Promise.resolve();
        obj.pong += 1;
        return obj;
    }

    public async any_hop(_: unknown, path: PublicRequest) {
        await Promise.resolve();
        assert(path.path.length > 0);
        return new HopServer(path.path.shift()!);
    }

    public async get_ct(_: unknown, req: PublicRequest): Promise<string> {
        await Promise.resolve();
        return req.headers.get('content-type')!;
    }
}

class HopServer extends OoServer {
    constructor(private hop: string) {
        super();
    }

    public async get_() {
        await Promise.resolve();
        return this.hop;
    }

    public async ws_(): Promise<IMessageHandler> {
        await Promise.resolve();
        return {
            closed: async () => {
                await Promise.resolve();
            },
            msg: null!,
            resultType: 'message-handler',
            start: async (out) => {
                try {
                    await tick();
                    await out.send(this.hop);
                    // await out.close();
                } catch (e) {
                    assert(false);
                }
            },
        };
    }
}

await suite('OoServer', async (ctx) => {
    const rest = new TestServer();
    const port = Math.floor(Math.random() * (2 ** 16 - 1024)) + 1024;
    const controller = new AbortController();
    const app = await ctx.later(async () => {
        await Promise.resolve();
        const app = new Application();
        rest.setup(app);
        return app;
    });

    const clientPromise = ctx.later(async () => {
        const start = new Promise<void>((ok, err) => {
            app.addEventListener('listen', () => {
                ok();
            });
            app.addEventListener('error', (e) => {
                err(e);
            });
        });
        await start;
        return new Requester(port);
    });

    const listeningPromise = ctx.later(async () => {
        await app.listen({ port, signal: controller.signal });
    });

    const client = await clientPromise;

    await ctx.test('should return hello world', async () => {
        const result = await client.request('/');
        assertEquals(result.body, 'Hello World!');
    });

    await ctx.test('should access sub path', async () => {
        const result = await client.request('/sub');
        assertEquals(result.body, 'sub');
    });

    await ctx.test(
        'should receive and send messages on websocket',
        async () => {
            const received = new Array<string>();
            let closed = false;
            let sendMsg: (msg: string) => Promise<void> = null!;

            rest.handler = {
                closed: async () => {
                    closed = true;
                    await Promise.resolve();
                },
                msg: async (msg: string) => {
                    received.push(msg);
                    await Promise.resolve();
                },
                resultType: 'message-handler',
                start: async (out) => {
                    sendMsg = out.send.bind(out);
                    await Promise.resolve();
                },
            };
            const ws = await client.connect('/listen');
            assertEquals(received.length, 0);
            ws.send('hello world');
            await tick();
            assertEquals(received.length, 1);
            assertEquals(received[0], 'hello world');

            let recvMsg = '';
            ws.onmessage = (msg) => {
                recvMsg = msg.data;
            };
            await sendMsg('Hello world!');
            await tick();
            assertEquals(recvMsg, 'Hello world!');

            assertEquals(closed, false);
            ws.close();
            await tick();
            assertEquals(closed, true);
        },
    );

    // await ctx.test('should be able to closed the socket', async () => {
    //     let closed = false;
    //     let clientClosed = false;
    //     let close: (error?: number, description?: string) => Promise<void>;

    //     rest.handler = {
    //         closed: async () => {
    //             closed = true;
    //             await Promise.resolve();
    //         },
    //         msg: null!,
    //         resultType: 'message-handler',
    //         start: async (out) => {
    //             close = out.close.bind(out);
    //             await Promise.resolve();
    //         },
    //     };

    //     const ws = await client.connect('/listen');
    //     ws.onclose = () => (clientClosed = true);
    //     await tick();
    //     assertEquals(clientClosed, false);
    //     await close!();
    //     await tick();
    //     assertEquals(clientClosed, true);
    //     assertEquals(closed, true);
    // });

    // await ctx.test(
    //     'should be able to close the websocket with error',
    //     async () => {
    //         let closed = false;
    //         let clientClosed = false;
    //         let close: (error?: number, description?: string) => Promise<void>;

    //         rest.handler = {
    //             closed: async () => {
    //                 closed = true;
    //                 await Promise.resolve();
    //             },
    //             msg: null!,
    //             resultType: 'message-handler',
    //             start: async (out) => {
    //                 close = out.close.bind(out);
    //                 await Promise.resolve();
    //             },
    //         };

    //         const ws = await client.connect('/listen');
    //         ws.onclose = (evt) => {
    //             assertEquals(evt.code, 500);
    //             assertEquals(evt.reason, 'hello world!');
    //             clientClosed = true;
    //         };
    //         await tick();
    //         assertEquals(clientClosed, false);
    //         await close!(500, 'hello world!');
    //         await tick();
    //         assertEquals(clientClosed, true);
    //     },
    // );

    await ctx.test(
        'should receive request body as first argument',
        async () => {
            const ping: IPingPong = { ping: 'hello', pong: '2' };
            const result = await client.request('/echo', 'PUT', ping);
            const pong: IPingPong = result.body as IPingPong;

            assertEquals(pong.ping, 'hello');
            assertEquals(pong.pong, '21');
        },
    );

    await ctx.test('should receive query as first argument', async () => {
        const result = await client.request('/echo?ping=hello&pong=3');
        const pong: IPingPong = result.body as IPingPong;

        assertEquals(pong.ping, 'hello');
        assertEquals(pong.pong, '31');
    });

    await ctx.test(
        'should receive manipulable path as second argument',
        async () => {
            const result = await client.request('hop/bola');
            assertEquals(result.body, 'bola');

            const conn = await client.connect('hop/gato');
            let messageReceived = false;
            conn.onmessage = (message) => {
                assert(!messageReceived);
                assertEquals(message.data, 'gato');
                messageReceived = true;
                conn.close();
            };
            await new Promise((ok) => (conn.onclose = ok));
            assert(messageReceived);
        },
    );

    await ctx.test('will receive the headers as well', async () => {
        const result = await client.request('/ct');
        assertEquals(result.body, 'application/json');
    });

    await ctx.later(async () => {
        controller.abort();
        await listeningPromise;
    });
});
