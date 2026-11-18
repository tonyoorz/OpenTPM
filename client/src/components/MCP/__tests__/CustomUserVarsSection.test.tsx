import { z } from 'zod';
import yaml from 'js-yaml';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { MCPOptionsSchema } from 'librechat-data-provider';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import CustomUserVarsSection from '../CustomUserVarsSection';

jest.mock('~/data-provider/Tools/queries', () => ({
  useMCPAuthValuesQuery: () => ({ data: { authValueFlags: {} } }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('CustomUserVarsSection', () => {
  const fields = {
    api_key: { title: 'My API Key', description: 'Your API key' },
  };

  it('renders autofill-prevention attributes on credential inputs', () => {
    render(
      <CustomUserVarsSection
        serverName="test-server"
        fields={fields}
        onSave={jest.fn()}
        onRevoke={jest.fn()}
      />,
    );

    const input = screen.getByLabelText(/My API Key/);
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('data-lpignore', 'true');
    expect(input).toHaveAttribute('data-1p-ignore', 'true');
  });

  it('renders non-sensitive fields as unmasked text while keeping secrets masked', () => {
    render(
      <CustomUserVarsSection
        serverName="test-server"
        fields={{
          api_key: { title: 'My API Key', description: 'Your API key' },
          project_key: { title: 'Project Key', description: 'Your project key', sensitive: false },
        }}
        onSave={jest.fn()}
        onRevoke={jest.fn()}
      />,
    );

    expect(screen.getByLabelText(/My API Key/)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/Project Key/)).toHaveAttribute('type', 'text');
  });

  it('renders the configured Fleem login link next to the masked access token', () => {
    const config = z
      .object({ mcpServers: z.object({ 'vizion-fleem': MCPOptionsSchema }) })
      .parse(
        yaml.load(readFileSync(path.resolve(__dirname, '../../../../../librechat.yaml'), 'utf8')),
      );
    const fieldsSchema = config.mcpServers['vizion-fleem'].customUserVars ?? {};
    render(
      <CustomUserVarsSection
        serverName="vizion-fleem"
        fields={fieldsSchema}
        onSave={jest.fn()}
        onRevoke={jest.fn()}
      />,
    );

    const login = screen.getByRole('link', { name: 'Sign in to Fleem' });
    expect(login).toHaveAttribute('href', 'https://integrate.bmwgroup.net/fleem/');
    expect(login).toHaveAttribute('target', '_blank');
    expect(login).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByLabelText(/Fleem Access Token/i)).toHaveAttribute('type', 'password');
    expect(screen.getByText(/Local Storage/)).toHaveTextContent('token');
  });

  it('saves a manually pasted Fleem access token under its configured credential key', async () => {
    const onSave = jest.fn();
    render(
      <CustomUserVarsSection
        serverName="vizion-fleem"
        fields={{ FLEEM_BEARER_TOKEN: { title: 'Fleem Access Token', sensitive: true } }}
        onSave={onSave}
        onRevoke={jest.fn()}
      />,
    );
    const input = screen.getByLabelText(/Fleem Access Token/);
    fireEvent.change(input, { target: { value: 'synthetic-fleem-access-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_save' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ FLEEM_BEARER_TOKEN: 'synthetic-fleem-access-token' }),
    );
    expect(input).toHaveAttribute('type', 'password');
  });
});
