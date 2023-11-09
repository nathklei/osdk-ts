/*
 * Copyright 2023 Palantir Technologies, Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {
  AggregationKeyDataType,
  OntologyDefinition,
  QueryDataTypeDefinition,
  RangeAggregationKeyDataType,
  ThinClient,
} from "@osdk/api";
import { createOpenApiRequest } from "@osdk/api";
import { executeQueryV2 } from "@osdk/gateway/requests";
import type { QueryThreeDimensionalAggregation } from "@osdk/gateway/types";
import { convertWireToOsdkObject } from "../../../client/objects/convertWireToOsdkObject";
import type {
  QueryNamesFrom,
  QueryParameters,
  WrappedQueryReturnType,
} from "../../../client/queries";
import type {
  BucketValue,
  QueryTwoDimensionalAggregation,
  Range,
  Rangeable,
} from "../../aggregations";
import {
  GeoPoint,
  GeoShape,
  isAttachment,
  isOntologyObject,
  LocalDate,
  Timestamp,
} from "../../baseTypes";
import type {
  ObjectSetDefinition,
  ParameterValue,
  PrimitiveParameterValue,
  QueryBucketKey,
} from "../../baseTypes";
import { ExecuteQueryErrorHandler, handleExecuteQueryError } from "..";
import { isOk } from "../Result";
import { getObject } from "./getObject";
import { wrapResult } from "./util/wrapResult";

export function executeQuery<
  O extends OntologyDefinition<any, any, any>,
  Q extends QueryNamesFrom<O>,
>(
  client: ThinClient<O>,
  apiName: Q,
  params?: QueryParameters<O, Q>,
): WrappedQueryReturnType<O, Q> {
  return wrapResult(
    async () => {
      const response: { value: PrimitiveParameterValue } = await executeQueryV2(
        createOpenApiRequest(client.stack, client.fetch),
        client.ontology.metadata.ontologyApiName,
        apiName as string,
        {
          parameters: params ? getRemappedParameters(params) : {},
        },
      );
      const remappedResponse = await remapQueryResponseType(
        client,
        client.ontology.queries[apiName].output,
        response.value,
      );

      return {
        value: remappedResponse,
      } as any;
    },
    e =>
      handleExecuteQueryError(
        new ExecuteQueryErrorHandler(),
        e,
        e.parameters,
      ),
  );
}

function getRemappedParameters(
  params: { [parameterId: string]: any },
): { [parameterId: string]: any } {
  const parameterMap: { [parameterName: string]: any } = {};
  const remappedParams = Object.entries(params).reduce(
    (acc, [key, value]) => {
      acc[key] = getParameterValueMapping(value);
      return acc;
    },
    parameterMap,
  );

  return remappedParams;
}

function getParameterValueMapping(
  value: ParameterValue,
): PrimitiveParameterValue {
  if (isOntologyObject(value)) {
    return getParameterValueMapping(value.__primaryKey);
  } else if (value instanceof LocalDate) {
    return value.toISOString();
  } else if (value instanceof Timestamp) {
    return value.toISOString();
  } else if (isAttachment(value)) {
    return value.attachmentRid!;
  } else if (Array.isArray(value)) {
    return value.map(a => getParameterValueMapping(a));
  } else if (value instanceof Set) {
    return Array.from(value, getParameterValueMapping);
  } else if (GeoShape.isGeoShape(value)) {
    return value.toGeoJson();
  } else if (value instanceof GeoPoint) {
    return value.toGeoJson();
  } else if (isOntologyObjectSet(value)) {
    return value.objectSetDefinition;
  } else if (typeof value === "object") {
    // Since structs are valid arguments for Queries, we map the values
    return Object.entries(value).reduce((acc, [key, structValue]) => {
      acc[key] = getParameterValueMapping(structValue);
      return acc;
    }, {} as { [key: string]: PrimitiveParameterValue });
  }

  return value as string | number | boolean;
}

function isOntologyObjectSet(
  obj: any,
): obj is { objectSetDefinition: ObjectSetDefinition } {
  return obj && obj.objectSetDefinition;
}

async function remapQueryResponseType(
  client: ThinClient<OntologyDefinition<any>>,
  definition: QueryDataTypeDefinition<any>,
  responseValue: PrimitiveParameterValue,
): Promise<ParameterValue> {
  // TODO can the backend really not send us null responses?

  // handle arrays
  if (definition.multiplicity) {
    const definitionWithoutMultiplicity = { type: definition.type };
    return await Promise.all(
      (responseValue as PrimitiveParameterValue[]).map(it =>
        remapQueryResponseType(client, definitionWithoutMultiplicity, it)
      ),
    );
  }

  switch (definition.type) {
    case "attachment":
      throw new Error("Attachment type not supported in response");
    case "date":
      return LocalDate.fromISOString(responseValue as string);
    case "timestamp":
      return Timestamp.fromISOString(responseValue as string);
    case "string":
      return responseValue as string;
    case "boolean":
      return responseValue as boolean;
    case "double":
    case "float":
    case "integer":
    case "long":
      return responseValue as number;
    default:
      const complexType = definition.type;
      switch (complexType.type) {
        case "object": {
          if (typeof responseValue !== "object") {
            const result = await getObject(
              client,
              complexType.object,
              responseValue,
              [],
            );

            if (isOk(result)) {
              return result.value;
            } else {
              throw result.error;
            }
          }

          // The API Gateway returns the object's primary key, but this is defensive
          // in the case we change it to return the full type
          return convertWireToOsdkObject(
            client,
            complexType.object,
            responseValue,
          );
        }

        case "set": {
          if (!Array.isArray(responseValue)) {
            throw new Error(
              `Expected response in array format, but received ${typeof responseValue}`,
            );
          }

          const remappedResponse = await Promise.all(
            responseValue.map(async arrayValue =>
              remapQueryResponseType(
                client,
                complexType.set,
                arrayValue,
              )
            ),
          );

          return new Set(remappedResponse);
        }

        case "struct": {
          if (typeof responseValue !== "object") {
            throw new Error(
              `Expected object response, but received ${typeof responseValue}`,
            );
          }

          const responseEntries = Object.entries(responseValue);
          const remappedResponseEntries = await Promise.all(
            responseEntries.map(async ([key, structValue]) => {
              const structType = complexType.struct[key];
              const remappedValue = await remapQueryResponseType(
                client,
                structType,
                structValue,
              );
              return [key, remappedValue];
            }),
          );
          const remappedResponse = remappedResponseEntries.reduce(
            (acc, [key, mappedValue]) => {
              acc[key as string] = mappedValue as ParameterValue;
              return acc;
            },
            {} as { [key: string]: ParameterValue },
          );

          return remappedResponse;
        }

        case "twoDimensionalAggregation": {
          const typedValue = responseValue as QueryTwoDimensionalAggregation;
          const groups = typedValue.groups.map(group => {
            const key = remapQueryBucketKeyType(
              complexType.twoDimensionalAggregation,
              group.key,
            );
            const value = remapQueryBucketValueType(
              complexType.twoDimensionalAggregation.valueType,
              group.value,
            );
            return {
              key,
              value,
            };
          });

          return {
            groups,
          };
        }

        case "threeDimensionalAggregation": {
          const typedValue = responseValue as QueryThreeDimensionalAggregation;
          const groups = typedValue.groups.map(group => {
            const key = remapQueryBucketKeyType(
              complexType.threeDimensionalAggregation,
              group.key,
            );
            const subBuckets = group.groups.map(subGroup => {
              return {
                key: remapQueryBucketKeyType(
                  complexType.threeDimensionalAggregation.valueType,
                  subGroup.key,
                ),
                value: remapQueryBucketValueType(
                  complexType.threeDimensionalAggregation.valueType.valueType,
                  subGroup.value,
                ),
              };
            });
            return {
              key,
              value: subBuckets,
            };
          });

          return {
            groups,
          };
        }

        case "objectSet":
          throw new Error("ObjectSet type not supported in response");
        case "union":
          throw new Error("Union type is not supported in response");
        default:
          const _: never = complexType;
          throw new Error(
            `Cannot remap query response of type ${
              JSON.stringify(complexType)
            }`,
          );
      }
  }
}

function remapQueryBucketKeyType(
  queryBucketKeyType: AggregationKeyDataType,
  value: any,
): QueryBucketKey {
  if (typeof queryBucketKeyType === "string") {
    switch (queryBucketKeyType) {
      case "string":
        return value as string;
      case "boolean":
        return value as boolean;
      default:
        const _: never = queryBucketKeyType;
    }
  } else {
    if (queryBucketKeyType.keyType === "range") {
      return remapRangeType(queryBucketKeyType, value);
    } else {
      throw new Error(
        `Cannot remapQueryBucketKeyType with unsupported type ${
          JSON.stringify(queryBucketKeyType)
        }`,
      );
    }
  }

  throw new Error(
    `Unsupported queryBucketKeyType ${
      JSON.stringify(queryBucketKeyType)
    } in remapQueryBucketKey`,
  );
}

function remapQueryBucketValueType(
  queryBucketValueType: "double" | "timestamp" | "date",
  value: any,
): BucketValue {
  switch (queryBucketValueType) {
    case "date":
      return LocalDate.fromISOString(value as string);
    case "double":
      return value as number;
    case "timestamp":
      return Timestamp.fromISOString(value as string);
    default:
      const _: never = queryBucketValueType;
      throw new Error(
        `Cannot remapQueryBucketValueType, ${queryBucketValueType} is unsupported`,
      );
  }
}

function remapRangeType(
  rangeType: RangeAggregationKeyDataType,
  value: any,
): Range<Rangeable> {
  switch (rangeType.keySubtype) {
    case "date":
      return {
        startValue: value.startValue
          ? LocalDate.fromISOString(value.startValue as string)
          : undefined,
        endValue: value.endValue
          ? LocalDate.fromISOString(value.endValue as string)
          : undefined,
      } as Range<Rangeable>;

    case "timestamp":
      return {
        startValue: value.startValue
          ? Timestamp.fromISOString(value.startValue as string)
          : undefined,
        endValue: value.endValue
          ? Timestamp.fromISOString(value.endValue as string)
          : undefined,
      } as Range<Rangeable>;

    case "double":
    case "integer":
      return {
        startValue: value.startValue as number | undefined,
        endValue: value.endValue as number | undefined,
      } as Range<Rangeable>;

    default:
      const _: never = rangeType.keySubtype;
      throw new Error(
        `Cannot remapRangeType with unsupported type ${rangeType.keySubtype}`,
      );
  }
}
