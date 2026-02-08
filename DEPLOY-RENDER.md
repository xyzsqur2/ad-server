# Deploy no Render

Para o deploy funcionar, o Render precisa encontrar todos os arquivos que o `server.js` importa.

## Erro: Cannot find module 'activation-keys.service.js'

Se o log do Render mostrar:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../services/activation-keys.service.js' imported from .../server.js
```

**Causa:** O arquivo `services/activation-keys.service.js` não está no repositório que o Render usa para o deploy (não foi commitado/empurrado).

**Solução:**

1. No repositório que o serviço **ad-server** do Render usa (mesmo repo ou repo só do ad-server):
   - Garanta que existe o arquivo **`services/activation-keys.service.js`** (na mesma pasta onde está `server.js`).
   - No seu projeto local, esse arquivo está em: **`ad-server/services/activation-keys.service.js`**.

2. Se o Render estiver configurado com **Root Directory** = `ad-server`:
   - O Render espera, na raiz do deploy: `server.js` e a pasta `services/` com todos os `.service.js`.
   - Adicione e envie ao GitHub:
     ```bash
     git add ad-server/services/activation-keys.service.js
     git commit -m "Add activation-keys.service.js for Render deploy"
     git push
     ```

3. Se o Render usar outra pasta como raiz (por exemplo `src`):
   - Coloque `activation-keys.service.js` na mesma pasta onde estão `server.js` e os outros arquivos de `services/` nessa raiz (ex.: `src/services/activation-keys.service.js`), depois faça commit e push.

4. Após o push, dispare um novo deploy no Render (ou aguarde o auto-deploy) e confira o log.

## Chaves de ativação não encontradas (claim retorna 404)

Se no Firebase Console as chaves existem em **Realtime Database (Asia)** mas o Render retorna "Nenhuma chave disponível", o servidor pode estar usando outro database (ex.: região US).

**Solução:** No Render, em **Environment** do serviço, adicione:

- **FIREBASE_DATABASE_URL** = `https://notification-sistem-default-rtdb.asia-southeast1.firebasedatabase.app`

Assim o Firebase Admin usa o mesmo Realtime Database onde estão as chaves. Faça um novo deploy após salvar a variável.
