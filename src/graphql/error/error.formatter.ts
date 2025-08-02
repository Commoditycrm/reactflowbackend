import { GraphQLError, GraphQLFormattedError } from "graphql";

const errorHandling = (
  formattedError: GraphQLFormattedError,
  error: unknown
): GraphQLFormattedError => {
  const actualError =
    error instanceof GraphQLError ? error.originalError || error : error;
  console.error("[GraphQL Error]", actualError);

  const result: GraphQLFormattedError = {
    message: formattedError.message || "Something went wrong",
    locations: formattedError.locations ?? [],
    extensions: {
      code: formattedError.extensions?.code || "INTERNAL_SERVER_ERROR",
    },
    ...(formattedError.path ? { path: formattedError.path } : {}),
    path: formattedError.path || [],
  };

  return result;
};

export default errorHandling;
