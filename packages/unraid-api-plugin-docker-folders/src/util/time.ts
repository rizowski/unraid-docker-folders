/** Unix seconds, which is what every timestamp column in this database holds. */
export function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}
