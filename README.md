# Backup Local

Aplicativo desktop para criar backups ZIP de pastas locais, executar cópias manualmente e manter uma rotina automática de retenção.

## Como instalar

Execute `Backup-Local-Setup-2.5.0.exe`, gerado dentro da pasta `dist`. O instalador cria os atalhos do aplicativo e o Backup Local abre sem uma janela de terminal.

Para iniciar em modo de desenvolvimento:

```powershell
npm install
npm start
```

## Recursos

- seleção nativa de múltiplas pastas de origem;
- escolha da pasta de destino;
- backup manual e agendado;
- execução em segundo plano pela bandeja do Windows;
- opção para iniciar silenciosamente junto com o Windows;
- encerramento completo pela interface ou pelo menu da bandeja;
- interface, bandeja, diálogos e notificações em português ou inglês;
- pausa individual de pastas, com registro do tempo pausado;
- proteção do último backup de uma pasta pausada contra limpeza por idade ou espaço;
- nomes personalizados para identificar as origens e seus arquivos ZIP;
- opção para respeitar as regras do `.gitignore` presente na raiz de cada origem;
- pontos no tempo organizados por pasta, incluindo backups criados antes de uma origem ser renomeada;
- restauração protegida: o estado atual completo é salvo antes de qualquer substituição;
- troca segura da pasta durante a restauração, evitando deixar uma versão parcial em caso de falha;
- execução em processo separado para não congelar a interface;
- cancelamento seguro com remoção de arquivos parciais;
- retenção por idade e espaço livre mínimo;
- histórico local de execuções;
- migração automática de `pastas.txt` e `destino.txt`;
- modo de serviço sem interface.

Somente arquivos iniciados por `BackupLocal_` entram na limpeza automática. Outros arquivos ZIP no destino não são alterados.

Ao fechar a janela, o aplicativo continua ativo para cumprir os agendamentos. Clique no ícone do Backup Local ao lado do relógio para reabrir, iniciar um backup ou usar **Sair completamente**.

## Modo de serviço

Para executar apenas o agendador, sem abrir a janela:

```powershell
npm run service
```

Para realizar um único backup e encerrar:

```powershell
node backup.js --once
```

## Desenvolvimento

```powershell
npm run check
npm test
```

Para gerar um novo instalador:

```powershell
npm run dist
```

Na versão instalada, as preferências e o histórico ficam em `%APPDATA%\Backup Local`. O destino inicial dos arquivos é `Documentos\Backup Local`. No modo de desenvolvimento, os dados continuam locais ao projeto e ignorados pelo Git.

## Assinatura do Windows

O instalador ainda não possui um certificado comercial Authenticode. Por isso, o Windows pode mostrar “Editor desconhecido” ou uma confirmação do SmartScreen. Isso não afeta o funcionamento, mas uma distribuição pública deve ser assinada com um certificado confiável.
