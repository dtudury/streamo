export function loopback(): {
    send(data: any): void;
    on(event: any, fn: any): void;
    off(event: any, fn: any): void;
    close(): void;
}[];
