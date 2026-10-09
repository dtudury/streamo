export class Upstream {
    constructor({ recaller, connection }: {
        recaller: any;
        connection: any;
    });
    hub: Hub;
    close(): void;
    #private;
}
import { Hub } from './Hub.js';
