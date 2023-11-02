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

import type { ObjectTypesFrom, OntologyDefinition } from "@osdk/api";
import type { OsdkLegacyObjectFrom } from "../../../client/OsdkObject";
import type { ObjectSetDefinition } from "../../baseTypes";
import type { OrderByClause } from "../../filters";
import type { LoadObjectSetError } from "../Errors";
import type { Result } from "../Result";
import type { ClientContext } from "./ClientContext";
import { loadObjectsPage } from "./loadObjectsPage";

export async function loadAllObjects<
  O extends OntologyDefinition<any>,
  K extends ObjectTypesFrom<O>,
  T extends OsdkLegacyObjectFrom<O, K>,
>(
  context: ClientContext,
  objectApiName: K,
  objectSetDefinition: ObjectSetDefinition,
  orderByClauses: OrderByClause[],
  selectedProperties: Array<keyof T> = [],
): Promise<Result<T[], LoadObjectSetError>> {
  const allObjects: T[] = [];
  let page = await loadObjectsPage<O, K, T>(
    context,
    objectApiName,
    objectSetDefinition,
    orderByClauses,
    selectedProperties,
  );

  if (page.type === "error") {
    return page;
  }

  allObjects.push(...page.value.data);
  while (page.type === "ok" && page.value.nextPageToken) {
    page = await loadObjectsPage<O, K, T>(
      context,
      objectApiName,
      objectSetDefinition,
      orderByClauses,
      selectedProperties,
      {
        pageToken: page.value.nextPageToken,
      },
    );

    if (page.type === "error") {
      return page;
    }

    allObjects.push(...page.value.data);
  }

  return { type: "ok", value: allObjects };
}
