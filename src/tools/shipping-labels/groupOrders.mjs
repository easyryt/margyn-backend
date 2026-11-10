// Ported from the supplied shipping-labels-tool. See provenance.json.
export function groupOrders(orders, groupBy) {
    const groups = {};
    for (const order of orders) {
        const key = order[groupBy] || "Unknown";
        if (!groups[key]) {
            groups[key] = [];
        }
        groups[key].push(order);
    }
    return groups;
}
