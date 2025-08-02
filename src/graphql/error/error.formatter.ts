import { GraphQLError, GraphQLFormattedError } from "graphql";

const errorHandling = (error: GraphQLError): GraphQLFormattedError => {
  return {
    message: error.message,
    locations: error.locations,
    path: error.path,
    extensions: error.extensions,
  };
};

export default errorHandling;
