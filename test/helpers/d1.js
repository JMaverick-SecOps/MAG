import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
export class TestD1 {
  constructor() {
    this.sqlite=new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys=ON");
    for(const file of readdirSync(new URL("../../migrations/",import.meta.url)).filter(f=>/\.sql$/.test(f)).sort()) this.sqlite.exec(readFileSync(new URL("../../migrations/"+file,import.meta.url),"utf8"));
  }
  prepare(sql) {
    const database=this.sqlite;
    return { sql, values:[], bind(...values){this.values=values;return this;},
      first(){return database.prepare(sql).get(...this.values) || null;},
      all(){return {results:database.prepare(sql).all(...this.values)};},
      run(){const r=database.prepare(sql).run(...this.values);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},
      execute(){if(/\bRETURNING\b/i.test(sql)){const rows=database.prepare(sql).all(...this.values);return {results:rows,meta:{changes:rows.length,last_row_id:rows[0]?.id}};} return /^\s*(SELECT|WITH)/i.test(sql)?this.all():this.run();}
    };
  }
  batch(statements){this.sqlite.exec("BEGIN IMMEDIATE");try{const results=statements.map(s=>s.execute());this.sqlite.exec("COMMIT");return results;}catch(e){this.sqlite.exec("ROLLBACK");throw e;}}
  close(){this.sqlite.close();}
}
