services:
  - type: web
    name: vendor2u
    runtime: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: DB_PATH
        value: /var/data/vendor2u.db
    disk:
      name: vendor2u-data
      mountPath: /var/data
      sizeGB: 1
