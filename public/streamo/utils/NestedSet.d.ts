export class NestedSet {
    get size(): any;
    add(root: any, ...rest: any[]): any;
    get(root: any, ...rest: any[]): any;
    delete(root: any, ...rest: any[]): void;
    deleteBranch(root: any, ...rest: any[]): any;
    values(...path: any[]): any;
    #private;
}
