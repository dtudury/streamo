export class Downstream {
    constructor({ hub, connection }: {
        hub: any;
        connection: any;
    });
    close(): void;
    #private;
}
