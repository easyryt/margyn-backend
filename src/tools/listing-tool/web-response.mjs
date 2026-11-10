// The copied Next handlers only use NextResponse.json; Express owns transport.
export const NextResponse = { json: (value, options) => Response.json(value, options) };
