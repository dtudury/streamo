export function wsConnection(ws: any): {
    send(data: any): void;
    on(event: any, fn: any): void;
    close(): void;
};
export function connectWs(url: any): Promise<any>;
